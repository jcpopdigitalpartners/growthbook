import {
  computeMaterializedColumnDiff,
  deriveMaterializedColumnsFromAttributes,
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
import {
  updateMaterializedColumns,
  WAREHOUSE_BUILTIN_COLUMN_NAMES,
  WAREHOUSE_BUILTIN_COLUMNS,
} from "back-end/src/services/clickhouse";

/**
 * Materialized column set a Managed Warehouse should contain: every non-
 * archived, mappable attribute in the org's attributeSchema plus the
 * warehouse's own built-in columns (ingestor-enriched + SDK top-level fields).
 * Built-ins never overlap with attribute columns because the migration and
 * seed paths both exclude built-in names from attributeSchema.
 */
export function getWarehouseMaterializedColumns(
  attributes: SDKAttribute[],
): MaterializedColumn[] {
  return [
    ...deriveMaterializedColumnsFromAttributes(attributes),
    ...WAREHOUSE_BUILTIN_COLUMNS,
  ];
}

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
 * One-time migration for Managed Warehouses that predate the attribute-driven
 * flow. Runs at most once per datasource — gated on
 * `settings.syncedMaterializedColumns` being undefined. Work done:
 *   - Backfill `attributeSchema` with an entry for any legacy
 *     `materializedColumns` whose `sourceField` isn't already an attribute.
 *     `hashAttribute: true` when the legacy column was an identifier.
 *   - Seed `syncedMaterializedColumns` on the datasource with the legacy
 *     column set — that's exactly what ClickHouse currently contains.
 *   - Drop `settings.materializedColumns`.
 *
 * Intentionally does NOT run ALTER TABLE or recreate views; the caller's
 * subsequent sync will diff the new snapshot against the target attribute
 * schema and do that work.
 *
 * Returns the attributes that were added so callers can merge them into any
 * in-flight updates to attributeSchema (the caller's `nextAttributeSchema`
 * was computed against the pre-migration schema and would otherwise drop
 * the backfilled entries).
 */
export async function ensureManagedWarehouseAttributesMigrated(
  context: ReqContext,
): Promise<SDKAttribute[]> {
  const datasource = (await getGrowthbookDatasource(
    context,
  )) as GrowthbookClickhouseDataSource | null;
  if (!datasource) return [];

  if (datasource.settings.syncedMaterializedColumns !== undefined) return [];

  const legacyColumns = datasource.settings.materializedColumns || [];
  const existingAttributes = context.org.settings?.attributeSchema || [];
  const { additions, skipped } = planManagedWarehouseAttributeMigration({
    legacyColumns,
    existingAttributes,
    // Warehouse built-ins (geo_*, ua_*, utm_*, url_*, …) are maintained
    // outside of attributeSchema, so don't create attributes for them even
    // when they appear in the legacy list.
    warehouseBuiltinColumnNames: WAREHOUSE_BUILTIN_COLUMN_NAMES,
  });

  if (skipped.length > 0) {
    logger.warn(
      { orgId: context.org.id, skipped },
      "Skipped legacy Managed Warehouse columns with unmappable datatypes during attributeSchema backfill",
    );
  }

  if (additions.length > 0) {
    const mergedSchema = [...existingAttributes, ...additions];
    await updateOrganization(context.org.id, {
      settings: { ...context.org.settings, attributeSchema: mergedSchema },
    });
    // Keep the in-memory context in sync so the caller's subsequent reads of
    // org.settings.attributeSchema see the backfilled entries.
    context.org.settings = {
      ...context.org.settings,
      attributeSchema: mergedSchema,
    };
    logger.info(
      {
        orgId: context.org.id,
        migratedProperties: additions.map((a) => a.property),
      },
      "Backfilled Managed Warehouse attributes from legacy materializedColumns",
    );
  }

  // Seed the snapshot with exactly what's in ClickHouse right now, and drop
  // the legacy field. updateDataSource uses $set on the whole settings object,
  // so we rebuild it explicitly.
  const { materializedColumns: _legacy, ...restSettings } = datasource.settings;
  await updateDataSource(context, datasource, {
    settings: {
      ...restSettings,
      syncedMaterializedColumns: legacyColumns,
    },
  });

  return additions;
}

/**
 * Bring ClickHouse in line with the given attributeSchema. Uses the datasource's
 * `syncedMaterializedColumns` snapshot as the "what CH currently has" baseline,
 * computes a diff, runs the ALTER TABLE / view recreation, and persists a fresh
 * snapshot on success.
 *
 * No-op when the organization doesn't have a Managed Warehouse datasource.
 * Callers must run `ensureManagedWarehouseAttributesMigrated` first to make
 * sure the snapshot is populated.
 */
export async function syncManagedWarehouseAttributes(
  context: ReqContext,
  {
    attributeSchema,
    renames = [],
  }: {
    attributeSchema: SDKAttribute[];
    renames?: { from: string; to: string }[];
  },
): Promise<void> {
  const datasource = (await getGrowthbookDatasource(
    context,
  )) as GrowthbookClickhouseDataSource | null;
  if (!datasource) return;

  const originalColumns = datasource.settings.syncedMaterializedColumns || [];
  const finalColumns = getWarehouseMaterializedColumns(attributeSchema);
  const diff = computeMaterializedColumnDiff({
    originalColumns,
    finalColumns,
    renames,
  });

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

  // Always refresh derived settings and the snapshot — hashAttribute flips
  // (identifier <-> dimension) don't require DDL but still change userIdTypes
  // and the exposure queries.
  const { userIdTypes, exposureQueries } =
    getManagedWarehouseDerivedSettings(finalColumns);

  await updateDataSource(context, datasource, {
    dateUpdated: new Date(),
    settings: {
      ...datasource.settings,
      userIdTypes,
      queries: {
        ...datasource.settings.queries,
        exposure: exposureQueries,
      },
      syncedMaterializedColumns: finalColumns,
    },
  });
}
