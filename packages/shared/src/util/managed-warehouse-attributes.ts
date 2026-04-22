import type { SDKAttribute, SDKAttributeType } from "../../types/organization";
import type { MaterializedColumn } from "../../types/datasource";
import type { FactTableColumnType } from "../../types/fact-table";

/**
 * Map an SDK attribute datatype to the MaterializedColumn representation the
 * ClickHouse service uses to generate DDL.
 *
 * Returns `undefined` for attributes that cannot be materialized (currently
 * there are none — every attribute datatype has a target — but the helper
 * stays defensive so new datatypes default to "skip" rather than silently
 * creating the wrong column type).
 */
export function materializedColumnTypeFromAttribute(
  datatype: SDKAttribute["datatype"],
):
  | { datatype: FactTableColumnType; arrayElementType?: "string" | "number" }
  | undefined {
  switch (datatype) {
    case "string":
    case "secureString":
    case "enum":
      return { datatype: "string" };
    case "number":
      return { datatype: "number" };
    case "boolean":
      return { datatype: "boolean" };
    case "string[]":
    case "secureString[]":
      return { datatype: "string", arrayElementType: "string" };
    case "number[]":
      return { datatype: "number", arrayElementType: "number" };
    default:
      return undefined;
  }
}

/**
 * Derive the list of ClickHouse materialized columns that correspond to the
 * organization's current attributeSchema. Archived attributes are excluded.
 *
 * Identifier semantics: attributes with `hashAttribute: true` are treated as
 * identifiers (they flow into `userIdTypes` and the auto-generated exposure
 * queries). Array-typed attributes are never identifiers because `hashAttribute`
 * is scalar-only in the UI and SDK.
 */
export function deriveMaterializedColumnsFromAttributes(
  attributes: SDKAttribute[],
): MaterializedColumn[] {
  const columns: MaterializedColumn[] = [];

  for (const attr of attributes) {
    if (attr.archived) continue;

    const mapped = materializedColumnTypeFromAttribute(attr.datatype);
    if (!mapped) continue;

    const isArray = !!mapped.arrayElementType;
    const canBeIdentifier =
      !isArray && (attr.datatype === "string" || attr.datatype === "number");
    const isIdentifier = canBeIdentifier && attr.hashAttribute === true;

    columns.push({
      columnName: attr.property,
      sourceField: attr.property,
      datatype: mapped.datatype,
      type: isIdentifier ? "identifier" : "dimension",
      ...(mapped.arrayElementType
        ? { arrayElementType: mapped.arrayElementType }
        : {}),
    });
  }

  return columns;
}

/**
 * Two derived columns are considered equivalent (same ClickHouse type) when
 * their datatype and array-element type match. Column name / role ("identifier"
 * vs "dimension") are intentionally ignored here because those can change
 * without requiring DDL.
 */
export function materializedColumnTypeEquals(
  a: MaterializedColumn,
  b: MaterializedColumn,
): boolean {
  return (
    a.datatype === b.datatype &&
    (a.arrayElementType ?? undefined) === (b.arrayElementType ?? undefined)
  );
}

export type MaterializedColumnDiff = {
  columnsToAdd: MaterializedColumn[];
  columnsToDelete: string[];
  columnsToRename: { from: string; to: string }[];
  finalColumns: MaterializedColumn[];
  originalColumns: MaterializedColumn[];
};

/**
 * Given the before/after materialized-column lists and an optional list of
 * renames (old columnName -> new columnName), produce the add/delete/rename
 * plan that the ClickHouse service consumes. Throws when a column would need
 * to change datatype while keeping the same name — that scenario is not
 * supported in a single ALTER TABLE and must be handled by deleting the
 * attribute and creating a new one.
 */
export function computeMaterializedColumnDiff({
  originalColumns,
  finalColumns,
  renames = [],
}: {
  originalColumns: MaterializedColumn[];
  finalColumns: MaterializedColumn[];
  renames?: { from: string; to: string }[];
}): MaterializedColumnDiff {
  const originalByName = new Map(originalColumns.map((c) => [c.columnName, c]));
  const finalByName = new Map(finalColumns.map((c) => [c.columnName, c]));

  const appliedRenames: { from: string; to: string }[] = [];
  for (const { from, to } of renames) {
    if (from === to) continue;
    const prev = originalByName.get(from);
    const next = finalByName.get(to);
    if (!prev || !next) continue;
    if (!materializedColumnTypeEquals(prev, next)) {
      // Type also changed — treat as drop + add instead of rename so
      // ClickHouse creates the new column with the correct datatype.
      continue;
    }
    originalByName.delete(from);
    originalByName.set(to, {
      ...prev,
      columnName: to,
      sourceField: to,
      type: next.type,
    });
    appliedRenames.push({ from, to });
  }

  const columnsToAdd: MaterializedColumn[] = [];
  for (const [name, col] of finalByName.entries()) {
    const prev = originalByName.get(name);
    if (!prev) {
      columnsToAdd.push(col);
      continue;
    }
    if (!materializedColumnTypeEquals(prev, col)) {
      throw new Error(
        `Cannot change the datatype of attribute "${name}" on a Managed Warehouse. Delete the attribute and create it again instead.`,
      );
    }
  }

  const columnsToDelete: string[] = [];
  for (const name of originalByName.keys()) {
    if (!finalByName.has(name)) columnsToDelete.push(name);
  }

  return {
    columnsToAdd,
    columnsToDelete,
    columnsToRename: appliedRenames,
    finalColumns,
    originalColumns,
  };
}

/**
 * Map a legacy MaterializedColumn's FactTableColumnType to the SDKAttribute
 * datatype it should become during backfill. Returns undefined for unmapped
 * datatypes (date / json / other) — those are logged and skipped during
 * migration rather than silently converted.
 */
export function legacyMaterializedColumnDatatypeToAttribute(
  datatype: FactTableColumnType,
): SDKAttributeType | undefined {
  switch (datatype) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      // date / json / other / ""
      // These cannot round-trip to an attribute cleanly, but in practice
      // the old UI only allowed string / number / boolean / "other" (which
      // was stored as string).
      return undefined;
  }
}

/**
 * Plan the migration of a Managed Warehouse datasource's legacy
 * `settings.materializedColumns` into the organization's attributeSchema.
 * Returns the list of attributes that should be appended (those whose
 * `property` isn't already present) and the list of columns we had to skip
 * because we couldn't map their datatype. Pure; no IO.
 *
 * `warehouseBuiltinColumnNames` is the set of columns that are maintained by
 * the warehouse itself (ingestor-produced fields like `ua_browser`,
 * `geo_country`, `utm_source`, …). Those never become attributes — they
 * aren't available to the SDK at assignment time — so we silently drop them
 * from the backfill even when they appear in the legacy list.
 */
export function planManagedWarehouseAttributeMigration({
  legacyColumns,
  existingAttributes,
  warehouseBuiltinColumnNames,
}: {
  legacyColumns: MaterializedColumn[];
  existingAttributes: SDKAttribute[];
  warehouseBuiltinColumnNames?: ReadonlySet<string>;
}): {
  additions: SDKAttribute[];
  skipped: { columnName: string; reason: string }[];
} {
  const additions: SDKAttribute[] = [];
  const skipped: { columnName: string; reason: string }[] = [];

  const existingByProperty = new Set(existingAttributes.map((a) => a.property));
  const seenInAdditions = new Set<string>();

  for (const col of legacyColumns) {
    // sourceField is the incoming event attribute name; it becomes the
    // attribute's `property`. columnName was historically allowed to differ
    // but in practice new-style attributes always match sourceField.
    const property = col.sourceField;

    if (warehouseBuiltinColumnNames?.has(property)) {
      // Covered by the warehouse built-in column set; not an SDK-visible
      // attribute, so don't backfill.
      continue;
    }

    if (existingByProperty.has(property) || seenInAdditions.has(property)) {
      continue;
    }

    const datatype = legacyMaterializedColumnDatatypeToAttribute(col.datatype);
    if (!datatype) {
      skipped.push({
        columnName: col.columnName,
        reason: `Unmapped datatype "${col.datatype}"`,
      });
      continue;
    }

    additions.push({
      property,
      datatype,
      hashAttribute: col.type === "identifier",
    });
    seenInAdditions.add(property);
  }

  return { additions, skipped };
}
