import {
  computeMaterializedColumnDiff,
  planManagedWarehouseAttributeMigration,
} from "shared/util";
import {
  GrowthbookClickhouseDataSource,
  MaterializedColumn,
} from "shared/types/datasource";
import { SDKAttribute } from "shared/types/organization";
import type { ReqContext } from "back-end/types/request";
import { logger } from "back-end/src/util/logger";
import {
  getGrowthbookDatasource,
  updateDataSource,
} from "back-end/src/models/DataSourceModel";
import { updateOrganization } from "back-end/src/models/OrganizationModel";
import { updateMaterializedColumns } from "back-end/src/services/clickhouse";

/**
 * Derive the portion of a Managed Warehouse datasource's settings that is
 * fully determined by the org's attributeSchema: the list of identifier user
 * id types and the default exposure queries (one per identifier).
 */
export function getManagedWarehouseDerivedSettings(
  materializedColumns: MaterializedColumn[],
): {
  userIdTypes: NonNullable<
    GrowthbookClickhouseDataSource["settings"]["userIdTypes"]
  >;
  exposureQueries: NonNullable<
    NonNullable<
      GrowthbookClickhouseDataSource["settings"]["queries"]
    >["exposure"]
  >;
} {
  const identifierColumns = materializedColumns.filter(
    (c) => c.type === "identifier",
  );
  const dimensions = materializedColumns
    .filter((c) => c.type === "dimension")
    .map((c) => c.columnName);

  const userIdTypes = identifierColumns.map((c) => ({
    userIdType: c.columnName,
    description: "",
  }));

  const exposureQueries = identifierColumns.map((c) => ({
    id: c.columnName,
    dimensions,
    name: c.columnName,
    userIdType: c.columnName,
    query: `
SELECT *
FROM experiment_views
WHERE
  experiment_id LIKE '{{ experimentId }}'
  AND timestamp BETWEEN '{{startDate}}' AND '{{endDate}}'`.trim(),
  }));

  return { userIdTypes, exposureQueries };
}

/**
 * Lazily migrate a Managed Warehouse datasource away from its legacy
 * `settings.materializedColumns` representation:
 *   - Any legacy column without a matching attribute is backfilled onto
 *     `org.settings.attributeSchema` (`hashAttribute: true` when it was an
 *     identifier). Existing attributes are left alone.
 *   - `datasource.settings.materializedColumns` is cleared.
 *
 * Idempotent. Returns the attributes that were added so callers can merge
 * them into any in-flight updates to attributeSchema. No-op when the org
 * has no Managed Warehouse datasource or the datasource is already migrated.
 *
 * The context's `org.settings` is mutated in place so subsequent reads in
 * the same request see the backfilled schema.
 */
export async function ensureManagedWarehouseAttributesMigrated(
  context: ReqContext,
): Promise<SDKAttribute[]> {
  const datasource = (await getGrowthbookDatasource(
    context,
  )) as GrowthbookClickhouseDataSource | null;
  if (!datasource) return [];

  const legacyColumns = datasource.settings.materializedColumns;
  if (!legacyColumns || legacyColumns.length === 0) return [];

  const existingAttributes = context.org.settings?.attributeSchema || [];
  const { additions, skipped } = planManagedWarehouseAttributeMigration({
    legacyColumns,
    existingAttributes,
  });

  if (skipped.length > 0) {
    logger.warn(
      { orgId: context.org.id, skipped },
      "Skipped legacy Managed Warehouse columns with unmappable datatypes during attributeSchema backfill",
    );
  }

  const migratedSchema = [...existingAttributes, ...additions];

  if (additions.length > 0) {
    await updateOrganization(context.org.id, {
      settings: { ...context.org.settings, attributeSchema: migratedSchema },
    });
    // Keep the in-memory context in sync so the caller's subsequent reads
    // of org.settings.attributeSchema see the backfilled entries.
    context.org.settings = {
      ...context.org.settings,
      attributeSchema: migratedSchema,
    };
    logger.info(
      {
        orgId: context.org.id,
        migratedProperties: additions.map((a) => a.property),
      },
      "Backfilled Managed Warehouse attributes from legacy materializedColumns",
    );
  }

  // Clear the legacy field before calling sync so the re-fetched datasource
  // inside sync has the cleaned settings. (updateDataSource writes the whole
  // `settings` field via $set, so doing this after sync would clobber the
  // userIdTypes / exposure queries sync just wrote.)
  const { materializedColumns: _legacy, ...restSettings } = datasource.settings;
  await updateDataSource(context, datasource, { settings: restSettings });

  // Bring ClickHouse in sync with the full post-migration attributeSchema.
  // `before` represents current ClickHouse state, which is exactly the set of
  // attributes we just backfilled from legacy columns. Any other attribute in
  // `migratedSchema` (e.g. the GrowthBook default `id`, `url`, `path`, …) will
  // be ADDed to ClickHouse now so the DDL and attributeSchema stay aligned.
  await syncManagedWarehouseAttributes(context, {
    before: additions,
    after: migratedSchema,
  });

  return additions;
}

/**
 * Keep the Managed Warehouse datasource in sync with an attributeSchema change.
 * - runs ALTER TABLE / view recreation to match the new attribute list
 * - refreshes derived userIdTypes + exposure queries on the datasource
 * No-op when the organization doesn't have a Managed Warehouse datasource.
 */
export async function syncManagedWarehouseAttributes(
  context: ReqContext,
  {
    before,
    after,
    renames = [],
  }: {
    before: SDKAttribute[];
    after: SDKAttribute[];
    renames?: { from: string; to: string }[];
  },
): Promise<void> {
  const datasource = (await getGrowthbookDatasource(
    context,
  )) as GrowthbookClickhouseDataSource | null;
  if (!datasource) return;

  const diff = computeMaterializedColumnDiff({ before, after, renames });

  const hasDDLWork =
    diff.columnsToAdd.length > 0 ||
    diff.columnsToDelete.length > 0 ||
    diff.columnsToRename.length > 0;

  if (hasDDLWork) {
    await updateMaterializedColumns({
      context,
      datasource,
      columnsToAdd: diff.columnsToAdd,
      columnsToDelete: diff.columnsToDelete,
      columnsToRename: diff.columnsToRename,
      finalColumns: diff.finalColumns,
      originalColumns: diff.originalColumns,
    });
  }

  // Always refresh the derived settings — even when the DDL didn't change,
  // hashAttribute flips (dimension <-> identifier) still need to propagate
  // into userIdTypes and the auto-generated exposure queries.
  const { userIdTypes, exposureQueries } = getManagedWarehouseDerivedSettings(
    diff.finalColumns,
  );

  await updateDataSource(context, datasource, {
    dateUpdated: new Date(),
    settings: {
      ...datasource.settings,
      userIdTypes,
      queries: {
        ...datasource.settings.queries,
        exposure: exposureQueries,
      },
    },
  });
}
