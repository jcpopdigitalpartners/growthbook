import { SDKAttribute } from "shared/types/organization";
import { validateManagedWarehouseColumnName } from "shared/util";
import { getGrowthbookDatasource } from "back-end/src/models/DataSourceModel";
import { updateOrganization } from "back-end/src/models/OrganizationModel";
import { getReservedColumnNames } from "back-end/src/services/clickhouse";
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
    skipManagedWarehouseNameValidation = false,
  }: {
    nextAttributeSchema: SDKAttribute[];
    renames?: { from: string; to: string }[];
    /**
     * Bypass the Managed Warehouse column-name validation. Intended for
     * system-triggered paths (e.g. `$groups` auto-add) where we accept that
     * the attribute won't materialize — `deriveMaterializedColumnsFromAttributes`
     * will silently skip invalid names downstream.
     */
    skipManagedWarehouseNameValidation?: boolean;
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

  // Reject newly-introduced attribute names that can't be materialized on a
  // Managed Warehouse. Existing attrs are grandfathered (they'll be silently
  // skipped by derive) so previously-accepted names don't start blocking
  // unrelated attribute edits. Only runs when the org has a Managed Warehouse.
  if (!skipManagedWarehouseNameValidation) {
    const managedWarehouse = await getGrowthbookDatasource(context);
    if (managedWarehouse) {
      const previousProperties = new Set(
        previousAttributeSchema.map((a) => a.property),
      );
      const reservedColumnNames = getReservedColumnNames();
      for (const attr of nextAttributeSchema) {
        if (previousProperties.has(attr.property)) continue;
        const reason = validateManagedWarehouseColumnName(
          attr.property,
          reservedColumnNames,
        );
        if (reason !== null) throw new Error(reason);
      }
    }
  }

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
      // `previousAttributeSchema` is the post-migration schema (read after
      // `ensureManagedWarehouseAttributesMigrated` ran), not the true
      // pre-request state. That's intentional: the migration is one-way and
      // idempotent, and a subsequent attribute write against the backfilled
      // schema is a no-op diff. We're rolling the user's requested edit back,
      // not the migration.
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
