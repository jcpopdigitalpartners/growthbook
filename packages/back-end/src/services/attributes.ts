import { SDKAttribute } from "shared/types/organization";
import { updateOrganization } from "back-end/src/models/OrganizationModel";
import {
  ensureManagedWarehouseAttributesMigrated,
  syncManagedWarehouseAttributes,
} from "back-end/src/services/clickhouseAttributes";
import { logger } from "back-end/src/util/logger";
import { ReqContext } from "back-end/types/request";

export async function removeTagInAttribute(
  context: ReqContext,
  tag: string,
): Promise<void> {
  const { org } = context;
  const attributeSchema = org.settings?.attributeSchema || [];

  const hasTag = attributeSchema.some((a) => (a.tags || []).includes(tag));
  if (!hasTag) return;

  const updatedAttributeSchema = attributeSchema.map((attr) => ({
    ...attr,
    tags: (attr.tags || []).filter((t) => t !== tag),
  }));

  await updateAttributeSchema(context, {
    nextAttributeSchema: updatedAttributeSchema,
  });
}

/**
 * Persist a new attributeSchema on the organization and keep any Managed
 * Warehouse datasource in sync (ClickHouse DDL + derived userIdTypes +
 * exposure queries).
 *
 * If the ClickHouse sync fails we roll the org settings back to the previous
 * value before re-throwing so callers see a consistent failure and don't end
 * up with attributes that have no backing column.
 */
export async function updateAttributeSchema(
  context: ReqContext,
  {
    nextAttributeSchema,
    renames = [],
  }: {
    nextAttributeSchema: SDKAttribute[];
    renames?: { from: string; to: string }[];
  },
): Promise<void> {
  const { org } = context;

  // Lazily migrate any legacy Managed Warehouse `materializedColumns` into
  // attributeSchema before doing the user's write. The caller computed
  // `nextAttributeSchema` against the pre-migration state, so any attributes
  // that the migration just backfilled would otherwise be dropped from the
  // org. Merge them in — caller's version wins for overlapping properties.
  const migratedAdditions =
    await ensureManagedWarehouseAttributesMigrated(context);
  if (migratedAdditions.length > 0) {
    const nextProperties = new Set(nextAttributeSchema.map((a) => a.property));
    nextAttributeSchema = [
      ...nextAttributeSchema,
      ...migratedAdditions.filter((a) => !nextProperties.has(a.property)),
    ];
  }

  const previousAttributeSchema = org.settings?.attributeSchema || [];

  await updateOrganization(org.id, {
    settings: { ...org.settings, attributeSchema: nextAttributeSchema },
  });

  try {
    await syncManagedWarehouseAttributes(context, {
      attributeSchema: nextAttributeSchema,
      renames,
    });
  } catch (e) {
    try {
      await updateOrganization(org.id, {
        settings: { ...org.settings, attributeSchema: previousAttributeSchema },
      });
    } catch (rollbackError) {
      logger.error(
        rollbackError,
        "Failed to roll back attributeSchema after Managed Warehouse sync failure",
      );
    }
    throw e;
  }
}
