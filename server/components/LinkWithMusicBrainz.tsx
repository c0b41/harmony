import { LinkedEntity } from './LinkedEntity.tsx';
import { SpriteIcon } from './SpriteIcon.tsx';
import type { ResolvableEntity } from '@/harmonizer/types.ts';
import { providers } from '@/providers/mod.ts';
import { musicbrainzBaseUrl } from '@/server/config.ts';
import type { EntityType } from '@kellnerd/musicbrainz/data/entity';
import { join } from 'std/url/join.ts';
import { flatten } from 'utils/object/flatten.js';

export function LinkWithMusicBrainz({ entity, entityType, sourceEntityUrl }: {
	entity: ResolvableEntity;
	entityType: EntityType;
	sourceEntityUrl: URL;
}) {
	if (!entity.externalIds?.length || !entity.mbid) return null;

	const externalLinks = entity.externalIds.map((externalId) => providers.constructEntityUrl(externalId));

	const mbEditLink = join(musicbrainzBaseUrl, entityType, entity.mbid, 'edit');
	mbEditLink.search = new URLSearchParams(flatten({
		[`edit-${entityType}`]: {
			// TODO: Prefill link types.
			url: externalLinks.map((link) => ({ text: link.href })),
			edit_note: `Matched ${entityType} while importing ${sourceEntityUrl} with Harmony`,
		},
	})).toString();

	return (
		<div class='message'>
			<SpriteIcon name='link' />
			<div>
				<p>
					<a href={mbEditLink.href}>
						Link external IDs
					</a>
					{' of '}
					<LinkedEntity entity={entity} entityType={entityType} displayName={entity.name ?? '[unknown]'} />{' '}
					to MusicBrainz
				</p>
			</div>
		</div>
	);
}