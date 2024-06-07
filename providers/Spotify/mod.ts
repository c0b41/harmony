import { type CacheEntry, MetadataApiProvider, ReleaseApiLookup } from '@/providers/base.ts';
import { DurationPrecision, FeatureQuality, FeatureQualityMap } from '@/providers/features.ts';
import { parseHyphenatedDate, PartialDate } from '@/utils/date.ts';
import { ResponseError } from '@/utils/errors.ts';
import { encodeBase64 } from 'std/encoding/base64.ts';
import { availableRegions } from './regions.ts';

import type {
	Album,
	ApiError,
	Copyright,
	Image,
	SearchResult,
	SimplifiedArtist,
	SimplifiedTrack,
} from './api_types.ts';
import type {
	ArtistCreditName,
	Artwork,
	EntityId,
	HarmonyMedium,
	HarmonyRelease,
	HarmonyTrack,
	Label,
} from '@/harmonizer/types.ts';

// See https://developer.spotify.com/documentation/web-api

const spotifyClientId = Deno.env.get('HARMONY_SPOTIFY_CLIENT_ID') || '';
const spotifyClientSecret = Deno.env.get('HARMONY_SPOTIFY_CLIENT_SECRET') || '';

export default class SpotifyProvider extends MetadataApiProvider {
	readonly name = 'Spotify';

	readonly supportedUrls = new URLPattern({
		hostname: 'open.spotify.com',
		pathname: '{/intl-:region}?/:type(artist|album)/:id',
	});

	readonly features: FeatureQualityMap = {
		'cover size': 640,
		'duration precision': DurationPrecision.MS,
		'GTIN lookup': FeatureQuality.GOOD,
		'MBID resolving': FeatureQuality.GOOD,
		'release label': FeatureQuality.PRESENT,
	};

	readonly entityTypeMap = {
		artist: 'artist',
		release: 'album',
	};

	readonly availableRegions = new Set(availableRegions);

	readonly releaseLookup = SpotifyReleaseLookup;

	readonly launchDate: PartialDate = {
		year: 2008,
		month: 10,
	};

	readonly apiBaseUrl = 'https://api.spotify.com/v1/';

	constructUrl(entity: EntityId): URL {
		return new URL([entity.type, entity.id].join('/'), 'https://open.spotify.com');
	}

	async query<Data>(apiUrl: URL, maxTimestamp?: number): Promise<CacheEntry<Data>> {
		const cacheEntry = await this.fetchJSON<Data>(apiUrl, {
			policy: { maxTimestamp },
			requestInit: {
				headers: {
					'Authorization': `Bearer ${await this.accessToken()}`,
				},
			},
		});
		const { error } = cacheEntry.content as { error?: ApiError };

		if (error) {
			throw new SpotifyResponseError(error, apiUrl);
		}
		return cacheEntry;
	}

	private async accessToken(): Promise<string> {
		const cacheKey = `${this.name}:accessKey`;
		let tokenResult = JSON.parse(localStorage.getItem(cacheKey) || '{}');
		if (!tokenResult?.accessToken || Date.now() > tokenResult?.validUntil) {
			tokenResult = await this.requestAccessToken();
			localStorage.setItem(cacheKey, JSON.stringify(tokenResult));
		}
		return tokenResult.accessToken;
	}

	private async requestAccessToken(): Promise<{ accessToken: string; validUntil: number }> {
		// See https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow
		const url = new URL('https://accounts.spotify.com/api/token');
		const auth = encodeBase64(`${spotifyClientId}:${spotifyClientSecret}`);
		const body = new URLSearchParams();
		body.append('grant_type', 'client_credentials');

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Basic ${auth}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: body,
		});

		const content = await response.json();
		return {
			accessToken: content?.access_token,
			validUntil: Date.now() + (content.expires_in * 1000),
		};
	}
}

export class SpotifyReleaseLookup extends ReleaseApiLookup<SpotifyProvider, Album> {
	constructReleaseApiUrl(): URL {
		let lookupUrl: URL;
		const query = new URLSearchParams();
		if (this.lookup.method === 'gtin') {
			lookupUrl = new URL(`search`, this.provider.apiBaseUrl);
			query.set('type', 'album');
			query.set('q', `upc:${this.lookup.value}`);
		} else { // if (method === 'id')
			lookupUrl = new URL(`albums/${this.lookup.value}`, this.provider.apiBaseUrl);
		}

		lookupUrl.search = query.toString();
		return lookupUrl;
	}

	protected async getRawRelease(): Promise<Album> {
		const apiUrl = this.constructReleaseApiUrl();
		if (this.lookup.method === 'gtin') {
			const cacheEntry = await this.provider.query<SearchResult>(
				apiUrl,
				this.options.snapshotMaxTimestamp,
			);
			if (!cacheEntry.content?.albums?.items?.length) {
				throw new ResponseError(this.provider.name, 'API returned no results', apiUrl);
			}

			// Result is a SimplifiedAlbum. Perform a regular ID lookup with the found release
			// ID to retrieve complete data.
			this.lookup.method = 'id';
			this.lookup.value = cacheEntry.content.albums.items[0].id;
		}

		const cacheEntry = await this.provider.query<Album>(
			this.constructReleaseApiUrl(),
			this.options.snapshotMaxTimestamp,
		);
		const release = cacheEntry.content;

		this.updateCacheTime(cacheEntry.timestamp);
		return release;
	}

	// deno-lint-ignore require-await
	private async getRawTracklist(rawRelease: Album): Promise<SimplifiedTrack[]> {
		// FIXME: Check whether the track list is complete and perform additional
		// queries if it is not.
		// Also ISRCs seem to be only available in separate queries.
		return rawRelease.tracks.items;
	}

	protected async convertRawRelease(rawRelease: Album): Promise<HarmonyRelease> {
		this.id = rawRelease.id;
		const rawTracklist = await this.getRawTracklist(rawRelease);
		const media = this.convertRawTracklist(rawTracklist);
		return {
			title: rawRelease.name,
			artists: rawRelease.artists.map(this.convertRawArtist.bind(this)),
			gtin: rawRelease.external_ids.ean || rawRelease.external_ids.upc,
			externalLinks: [{
				url: new URL(rawRelease.external_urls.spotify),
				types: ['free streaming'],
			}],
			media,
			releaseDate: parseHyphenatedDate(rawRelease.release_date),
			copyright: this.getCopyright(rawRelease.copyrights),
			status: 'Official',
			packaging: 'None',
			images: this.getLargestCoverImage(rawRelease.images),
			labels: this.getLabels(rawRelease),
			availableIn: rawRelease.available_markets,
			info: this.generateReleaseInfo(),
		};
	}

	private convertRawTracklist(tracklist: SimplifiedTrack[]): HarmonyMedium[] {
		const result: HarmonyMedium[] = [];
		let medium: HarmonyMedium = {
			number: 1,
			format: 'Digital Media',
			tracklist: [],
		};

		// split flat tracklist into media
		tracklist.forEach((item) => {
			// store the previous medium and create a new one
			if (item.disc_number !== medium.number) {
				result.push(medium);

				medium = {
					number: item.disc_number,
					format: 'Digital Media',
					tracklist: [],
				};
			}

			medium.tracklist.push(this.convertRawTrack(item));
		});

		// store the final medium
		result.push(medium);

		return result;
	}

	private convertRawTrack(track: SimplifiedTrack): HarmonyTrack {
		const result: HarmonyTrack = {
			number: track.track_number,
			title: track.name,
			length: track.duration_ms,
			// isrc: track., // FIXME
			artists: track.artists.map(this.convertRawArtist.bind(this)),
			availableIn: track.available_markets,
		};

		return result;
	}

	private convertRawArtist(artist: SimplifiedArtist): ArtistCreditName {
		return {
			name: artist.name,
			creditedName: artist.name,
			externalIds: this.provider.makeExternalIds({ type: 'artist', id: artist.id }),
		};
	}

	private getLargestCoverImage(images: Image[]): Artwork[] {
		let largestImage: Image | undefined;
		let thumbnail: Image | undefined;
		images.forEach((i) => {
			if (!largestImage || i.width > largestImage.width) {
				largestImage = i;
			}
			if (i.width >= 200 && (!thumbnail || i.width < thumbnail.width)) {
				thumbnail = i;
			}
		});
		if (!largestImage) return [];
		let thumbUrl: URL | undefined;
		if (thumbnail) {
			thumbUrl = new URL(thumbnail.url);
		}
		return [{
			url: new URL(largestImage.url),
			thumbUrl: thumbUrl,
			types: ['front'],
		}];
	}

	private getLabels(rawRelease: Album): Label[] {
		if (rawRelease.label) {
			return [{
				name: rawRelease.label,
			}];
		}

		return [];
	}

	private getCopyright(copyrights: Copyright[]): string {
		return copyrights.map(this.formatCopyright).join('\n');
	}

	private formatCopyright(copyright: Copyright): string {
		// As Spotify provides separate fields for copyright and phonographic
		// copyright those get often entered without the corresponding symbol.
		// When only importing the text entry the information gets lost. Hence
		// prefix the entries with the © or ℗ symbol if it is not already present.
		let { text, type } = copyright;
		text = text.replace(/\(c\)/i, '©').replace(/\(p\)/i, '℗');
		if (!text.includes('©') && !text.includes('℗')) {
			text = `${type === 'P' ? '℗' : '©'} ${text}`;
		}
		return text;
	}
}

class SpotifyResponseError extends ResponseError {
	constructor(readonly details: ApiError, url: URL) {
		super('Spotify', details?.error?.message, url);
	}
}