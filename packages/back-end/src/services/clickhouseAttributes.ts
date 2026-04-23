import {
  computeMaterializedColumnDiff,
  deriveMaterializedColumnsFromAttributes,
  isLegacyPassThroughColumn,
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
  lockDataSource,
  unlockDataSource,
  updateDataSource,
} from "back-end/src/models/DataSourceModel";
import { updateOrganization } from "back-end/src/models/OrganizationModel";
import {
  _updateMaterializedColumnsUnsafe,
  getReservedColumnNames,
  WAREHOUSE_BUILTIN_COLUMN_NAMES,
  WAREHOUSE_BUILTIN_COLUMNS,
} from "back-end/src/services/clickhouse";

/**
 * Materialized column set a Managed Warehouse should contain: every non-
 * archived, mappable attribute in the org's attributeSchema plus the
 * warehouse's own built-in columns (ingestor-enriched + SDK top-level fields).
 *
 * Attributes and built-ins can conflict by name (an org's default attributes
 * include `url`, which is also a warehouse built-in). When that happens the
 * attribute wins so the user's explicit schema is authoritative — the built-in
 * copy is deduped out to keep the CREATE TABLE column list unique.
 *
 * `columnNameOverrides` lets the caller preserve a historical
 * `sourceField → columnName` mapping. The pre-refactor Key Attributes UI
 * allowed customers to pick a ClickHouse column name that differs from the
 * attribute source field; without an override, the first post-migration sync
 * would drop the existing column and create a new one matching the attribute
 * property (data loss). The sync path passes the current
 * `syncedMaterializedColumns` snapshot's overrides so the existing mapping is
 * preserved.
 */
export function getWarehouseMaterializedColumns(
  attributes: SDKAttribute[],
  {
    columnNameOverrides,
    orgId,
  }: {
    columnNameOverrides?: ReadonlyMap<string, string>;
    orgId?: string;
  } = {},
): MaterializedColumn[] {
  const attributeColumns = deriveMaterializedColumnsFromAttributes(attributes, {
    reservedColumnNames: getReservedColumnNames(),
    onInvalidAttribute: (attr, reason) => {
      logger.warn(
        { orgId, property: attr.property, reason },
        "Skipping attribute from Managed Warehouse materialization (invalid column name)",
      );
    },
  }).map((col) => {
    const override = columnNameOverrides?.get(col.sourceField);
    return override && override !== col.columnName
      ? { ...col, columnName: override }
      : col;
  });
  const attributeColumnNames = new Set(
    attributeColumns.map((c) => c.columnName),
  );
  const unshadowedBuiltins = WAREHOUSE_BUILTIN_COLUMNS.filter(
    (c) => !attributeColumnNames.has(c.columnName),
  );
  return [...attributeColumns, ...unshadowedBuiltins];
}

/**
 * Extract the `sourceField → columnName` overrides from a set of materialized
 * columns (typically the `syncedMaterializedColumns` snapshot). Only entries
 * whose `columnName` differs from their `sourceField` contribute — default
 * mappings where the two match don't need overriding.
 */
export function extractColumnNameOverrides(
  columns: MaterializedColumn[],
): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const col of columns) {
    if (col.sourceField !== col.columnName) {
      overrides.set(col.sourceField, col.columnName);
    }
  }
  return overrides;
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
  const initialDatasource = (await getGrowthbookDatasource(
    context,
  )) as GrowthbookClickhouseDataSource | null;
  if (!initialDatasource) return;

  // Lock the datasource for the entire read-compute-write sequence so two
  // concurrent attribute writes (e.g., a user PUT racing the `$groups` auto-add)
  // can't both read the same snapshot, compute overlapping diffs, and clobber
  // each other's `syncedMaterializedColumns` writes. `lockDataSource` throws
  // if already locked; the caller's catch will roll back the attributeSchema
  // write with a retryable error.
  await lockDataSource(context, initialDatasource, 300);

  try {
    // Re-fetch after acquiring the lock so we read the freshest snapshot. Any
    // concurrent writer that finished before us is now visible, and anyone who
    // starts after us will wait on the lock.
    const datasource = (await getGrowthbookDatasource(
      context,
    )) as GrowthbookClickhouseDataSource | null;
    if (!datasource) return;

    await runManagedWarehouseSync(context, datasource, {
      attributeSchema,
      renames,
    });
  } finally {
    await unlockDataSource(context, initialDatasource);
  }
}

async function runManagedWarehouseSync(
  context: ReqContext,
  datasource: GrowthbookClickhouseDataSource,
  {
    attributeSchema,
    renames,
  }: {
    attributeSchema: SDKAttribute[];
    renames: { from: string; to: string }[];
  },
): Promise<void> {
  const originalColumns = datasource.settings.syncedMaterializedColumns || [];
  // Pre-refactor orgs may have columns whose ClickHouse name differs from the
  // attribute's sourceField. Preserve that mapping from the snapshot so we
  // don't drop-and-recreate otherwise-identical columns.
  const columnNameOverrides = extractColumnNameOverrides(originalColumns);
  const attributeAndBuiltinColumns = getWarehouseMaterializedColumns(
    attributeSchema,
    { columnNameOverrides, orgId: context.org.id },
  );
  // Pre-refactor warehouses could contain columns with datatypes the new
  // attribute flow can't express (date / json / other / ""). The migration
  // skips backfilling them as attributes, but their snapshot entry is still
  // in `originalColumns`. Append them to `finalColumns` so the diff treats
  // them as unchanged instead of silently dropping them.
  const knownColumnNames = new Set(
    attributeAndBuiltinColumns.map((c) => c.columnName),
  );
  const passThroughColumns = originalColumns.filter(
    (c) => isLegacyPassThroughColumn(c) && !knownColumnNames.has(c.columnName),
  );
  // Detect the narrow case where a new attribute's column name collides with a
  // pre-existing legacy pass-through column (datatype date/json/other/""). The
  // user has no UI surface for the pass-through column, so without a clear
  // error they'd hit an opaque "Cannot change the datatype" from the diff step
  // with no diagnostic path. Throw early with actionable guidance.
  const shadowedPassThroughs = originalColumns.filter(
    (c) => isLegacyPassThroughColumn(c) && knownColumnNames.has(c.columnName),
  );
  if (shadowedPassThroughs.length > 0) {
    const names = shadowedPassThroughs.map((c) => c.columnName).join(", ");
    throw new Error(
      `Cannot create attributes that collide with legacy Managed Warehouse columns: ${names}. These columns predate the attribute flow and can't be represented as attributes. Rename your attribute, or contact support to recreate the warehouse.`,
    );
  }
  const finalColumns = [...attributeAndBuiltinColumns, ...passThroughColumns];
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
    await _updateMaterializedColumnsUnsafe({
      context,
      datasource,
      columnsToAdd: diff.columnsToAdd,
      columnsToDelete: diff.columnsToDelete,
      columnsToRename: diff.columnsToRename,
      finalColumns: diff.finalColumns,
      originalColumns: diff.originalColumns,
    });
  }

  // Regenerate derived `userIdTypes` + default `queries.exposure` only when the
  // materialized-column set changed structurally: identifier set changed
  // (adds/removes, renames, or `hashAttribute` flips between identifier and
  // dimension) OR any dimension was removed or renamed. Purely additive edits
  // (new dimension attribute, description-only changes) don't regenerate — they
  // leave any customer-edited exposure query or userIdTypes list alone.
  //
  // When we do regenerate we rebuild from defaults wholesale; this matches main's
  // clobber-on-column-change behavior while narrowing the trigger so that the
  // majority of attribute edits (most of which are additive or non-column) pass
  // through untouched.
  const prevIdentifiers = new Set(
    originalColumns
      .filter((c) => c.type === "identifier")
      .map((c) => c.columnName),
  );
  const nextIdentifiers = new Set(
    finalColumns
      .filter((c) => c.type === "identifier")
      .map((c) => c.columnName),
  );
  const identifierSetChanged =
    prevIdentifiers.size !== nextIdentifiers.size ||
    [...prevIdentifiers].some((id) => !nextIdentifiers.has(id));
  const hasRemovalOrRename =
    diff.columnsToDelete.length > 0 || diff.columnsToRename.length > 0;
  const shouldRegenerateDerivedSettings =
    identifierSetChanged || hasRemovalOrRename;

  // Write the snapshot first, as a dedicated update. If this second write
  // (derived settings) fails, the snapshot still accurately reflects CH state
  // and the next sync can compute a correct diff — without this split, a
  // failure between DDL success and the end of this function would leave the
  // snapshot stale, stranding orphan CH columns that no future sync would
  // ever diff away.
  await updateDataSource(context, datasource, {
    dateUpdated: new Date(),
    settings: {
      ...datasource.settings,
      syncedMaterializedColumns: finalColumns,
    },
  });

  if (shouldRegenerateDerivedSettings) {
    const { userIdTypes, exposureQueries } =
      getManagedWarehouseDerivedSettings(finalColumns);
    await updateDataSource(context, datasource, {
      dateUpdated: new Date(),
      settings: {
        ...datasource.settings,
        syncedMaterializedColumns: finalColumns,
        userIdTypes,
        queries: {
          ...datasource.settings.queries,
          exposure: exposureQueries,
        },
      },
    });
  }
}
