import type { SDKAttribute } from "../../types/organization";
import type { MaterializedColumn } from "../../types/datasource";
import {
  computeMaterializedColumnDiff,
  deriveMaterializedColumnsFromAttributes,
  materializedColumnTypeFromAttribute,
  planManagedWarehouseAttributeMigration,
} from "../../src/util/managed-warehouse-attributes";

describe("materializedColumnTypeFromAttribute", () => {
  it("maps scalar types", () => {
    expect(materializedColumnTypeFromAttribute("string")).toEqual({
      datatype: "string",
    });
    expect(materializedColumnTypeFromAttribute("number")).toEqual({
      datatype: "number",
    });
    expect(materializedColumnTypeFromAttribute("boolean")).toEqual({
      datatype: "boolean",
    });
  });

  it("maps secureString and enum to string", () => {
    expect(materializedColumnTypeFromAttribute("secureString")).toEqual({
      datatype: "string",
    });
    expect(materializedColumnTypeFromAttribute("enum")).toEqual({
      datatype: "string",
    });
  });

  it("maps array types with element type", () => {
    expect(materializedColumnTypeFromAttribute("string[]")).toEqual({
      datatype: "string",
      arrayElementType: "string",
    });
    expect(materializedColumnTypeFromAttribute("secureString[]")).toEqual({
      datatype: "string",
      arrayElementType: "string",
    });
    expect(materializedColumnTypeFromAttribute("number[]")).toEqual({
      datatype: "number",
      arrayElementType: "number",
    });
  });
});

describe("deriveMaterializedColumnsFromAttributes", () => {
  it("returns an empty list for no attributes", () => {
    expect(deriveMaterializedColumnsFromAttributes([])).toEqual([]);
  });

  it("uses property as both columnName and sourceField", () => {
    const result = deriveMaterializedColumnsFromAttributes([
      { property: "foo", datatype: "string" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].columnName).toBe("foo");
    expect(result[0].sourceField).toBe("foo");
  });

  it("marks hashAttribute string/number as identifier, else dimension", () => {
    const attrs: SDKAttribute[] = [
      { property: "device_id", datatype: "string", hashAttribute: true },
      { property: "user_id", datatype: "number", hashAttribute: true },
      { property: "country", datatype: "string" },
      { property: "is_beta", datatype: "boolean" },
    ];
    const result = deriveMaterializedColumnsFromAttributes(attrs);
    expect(result.map((c) => [c.columnName, c.type])).toEqual([
      ["device_id", "identifier"],
      ["user_id", "identifier"],
      ["country", "dimension"],
      ["is_beta", "dimension"],
    ]);
  });

  it("does not treat array or boolean attributes as identifiers", () => {
    const attrs: SDKAttribute[] = [
      // hashAttribute should be ignored on array types
      { property: "tags", datatype: "string[]", hashAttribute: true },
      // and boolean
      { property: "flag", datatype: "boolean", hashAttribute: true },
    ];
    const result = deriveMaterializedColumnsFromAttributes(attrs);
    expect(result.every((c) => c.type === "dimension")).toBe(true);
  });

  it("treats hashAttribute secureString as dimension (not identifier)", () => {
    // hashAttribute is used to flag attributes that should be SHA256-hashed
    // for the SDK. They still need to be materialized but shouldn't become
    // identifiers.
    const result = deriveMaterializedColumnsFromAttributes([
      { property: "email", datatype: "secureString", hashAttribute: true },
    ]);
    expect(result[0].type).toBe("dimension");
  });

  it("skips archived attributes", () => {
    const result = deriveMaterializedColumnsFromAttributes([
      { property: "keep", datatype: "string" },
      { property: "gone", datatype: "string", archived: true },
    ]);
    expect(result.map((c) => c.columnName)).toEqual(["keep"]);
  });

  it("attaches arrayElementType to array columns", () => {
    const result = deriveMaterializedColumnsFromAttributes([
      { property: "str_list", datatype: "string[]" },
      { property: "num_list", datatype: "number[]" },
      { property: "sec_list", datatype: "secureString[]" },
      { property: "scalar", datatype: "string" },
    ]);
    expect(
      result.map((c) => [c.columnName, c.datatype, c.arrayElementType]),
    ).toEqual([
      ["str_list", "string", "string"],
      ["num_list", "number", "number"],
      ["sec_list", "string", "string"],
      ["scalar", "string", undefined],
    ]);
  });
});

describe("computeMaterializedColumnDiff", () => {
  it("returns empty diffs when before === after", () => {
    const attrs: SDKAttribute[] = [
      { property: "device_id", datatype: "string", hashAttribute: true },
      { property: "country", datatype: "string" },
    ];
    const diff = computeMaterializedColumnDiff({ before: attrs, after: attrs });
    expect(diff.columnsToAdd).toEqual([]);
    expect(diff.columnsToDelete).toEqual([]);
    expect(diff.columnsToRename).toEqual([]);
  });

  it("detects additions and deletions", () => {
    const before: SDKAttribute[] = [
      { property: "device_id", datatype: "string", hashAttribute: true },
      { property: "old_dim", datatype: "string" },
    ];
    const after: SDKAttribute[] = [
      { property: "device_id", datatype: "string", hashAttribute: true },
      { property: "new_dim", datatype: "string" },
    ];
    const diff = computeMaterializedColumnDiff({ before, after });
    expect(diff.columnsToAdd.map((c) => c.columnName)).toEqual(["new_dim"]);
    expect(diff.columnsToDelete).toEqual(["old_dim"]);
    expect(diff.columnsToRename).toEqual([]);
  });

  it("detects additions when an attribute is unarchived", () => {
    const before: SDKAttribute[] = [
      { property: "foo", datatype: "string", archived: true },
    ];
    const after: SDKAttribute[] = [{ property: "foo", datatype: "string" }];
    const diff = computeMaterializedColumnDiff({ before, after });
    expect(diff.columnsToAdd.map((c) => c.columnName)).toEqual(["foo"]);
    expect(diff.columnsToDelete).toEqual([]);
  });

  it("detects deletions when an attribute is archived", () => {
    const before: SDKAttribute[] = [{ property: "foo", datatype: "string" }];
    const after: SDKAttribute[] = [
      { property: "foo", datatype: "string", archived: true },
    ];
    const diff = computeMaterializedColumnDiff({ before, after });
    expect(diff.columnsToAdd).toEqual([]);
    expect(diff.columnsToDelete).toEqual(["foo"]);
  });

  it("turns a property rename into a ClickHouse RENAME COLUMN", () => {
    const before: SDKAttribute[] = [
      { property: "country", datatype: "string" },
    ];
    const after: SDKAttribute[] = [
      { property: "geo_country", datatype: "string" },
    ];
    const diff = computeMaterializedColumnDiff({
      before,
      after,
      renames: [{ from: "country", to: "geo_country" }],
    });
    expect(diff.columnsToAdd).toEqual([]);
    expect(diff.columnsToDelete).toEqual([]);
    expect(diff.columnsToRename).toEqual([
      { from: "country", to: "geo_country" },
    ]);
  });

  it("ignores a rename entry whose types don't match (falls back to add+delete)", () => {
    const before: SDKAttribute[] = [{ property: "foo", datatype: "string" }];
    const after: SDKAttribute[] = [{ property: "bar", datatype: "number" }];
    const diff = computeMaterializedColumnDiff({
      before,
      after,
      renames: [{ from: "foo", to: "bar" }],
    });
    expect(diff.columnsToAdd.map((c) => c.columnName)).toEqual(["bar"]);
    expect(diff.columnsToDelete).toEqual(["foo"]);
    expect(diff.columnsToRename).toEqual([]);
  });

  it("throws when datatype changes with the same column name", () => {
    const before: SDKAttribute[] = [{ property: "foo", datatype: "string" }];
    const after: SDKAttribute[] = [{ property: "foo", datatype: "number" }];
    expect(() => computeMaterializedColumnDiff({ before, after })).toThrow(
      /Cannot change the datatype/,
    );
  });

  it("does not require DDL when only hashAttribute flips", () => {
    const before: SDKAttribute[] = [
      { property: "user_id", datatype: "string" },
    ];
    const after: SDKAttribute[] = [
      { property: "user_id", datatype: "string", hashAttribute: true },
    ];
    const diff = computeMaterializedColumnDiff({ before, after });
    expect(diff.columnsToAdd).toEqual([]);
    expect(diff.columnsToDelete).toEqual([]);
    expect(diff.columnsToRename).toEqual([]);
    expect(diff.finalColumns[0].type).toBe("identifier");
    expect(diff.originalColumns[0].type).toBe("dimension");
  });
});

describe("planManagedWarehouseAttributeMigration", () => {
  const legacyCol = (
    overrides: Partial<MaterializedColumn>,
  ): MaterializedColumn => ({
    columnName: overrides.columnName ?? overrides.sourceField ?? "col",
    sourceField: overrides.sourceField ?? overrides.columnName ?? "col",
    datatype: overrides.datatype ?? "string",
    type: overrides.type,
  });

  it("returns no additions when legacy list is empty", () => {
    const result = planManagedWarehouseAttributeMigration({
      legacyColumns: [],
      existingAttributes: [],
    });
    expect(result.additions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("converts identifier + dimension columns into attributes", () => {
    const result = planManagedWarehouseAttributeMigration({
      legacyColumns: [
        legacyCol({ sourceField: "device_id", type: "identifier" }),
        legacyCol({ sourceField: "geo_country", type: "dimension" }),
        legacyCol({ sourceField: "url_path", type: "" }),
      ],
      existingAttributes: [],
    });
    expect(result.additions).toEqual([
      {
        property: "device_id",
        datatype: "string",
        hashAttribute: true,
      },
      {
        property: "geo_country",
        datatype: "string",
        hashAttribute: false,
      },
      {
        property: "url_path",
        datatype: "string",
        hashAttribute: false,
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("skips legacy columns that already have an attribute", () => {
    const result = planManagedWarehouseAttributeMigration({
      legacyColumns: [
        legacyCol({ sourceField: "device_id", type: "identifier" }),
        legacyCol({ sourceField: "geo_country", type: "dimension" }),
      ],
      existingAttributes: [
        // Already present, and with a different hashAttribute value: we
        // preserve the user's version and don't touch it.
        { property: "device_id", datatype: "string", hashAttribute: false },
      ],
    });
    expect(result.additions.map((a) => a.property)).toEqual(["geo_country"]);
  });

  it("maps number and boolean legacy datatypes", () => {
    const result = planManagedWarehouseAttributeMigration({
      legacyColumns: [
        legacyCol({ sourceField: "amount", datatype: "number" }),
        legacyCol({ sourceField: "is_beta", datatype: "boolean" }),
      ],
      existingAttributes: [],
    });
    expect(result.additions).toEqual([
      { property: "amount", datatype: "number", hashAttribute: false },
      { property: "is_beta", datatype: "boolean", hashAttribute: false },
    ]);
  });

  it("reports skips for unmappable legacy datatypes", () => {
    const result = planManagedWarehouseAttributeMigration({
      legacyColumns: [
        legacyCol({
          columnName: "event_date",
          sourceField: "event_date",
          datatype: "date",
        }),
        legacyCol({
          columnName: "payload",
          sourceField: "payload",
          datatype: "json",
        }),
      ],
      existingAttributes: [],
    });
    expect(result.additions).toEqual([]);
    expect(result.skipped.map((s) => s.columnName)).toEqual([
      "event_date",
      "payload",
    ]);
  });

  it("deduplicates legacy columns that share a sourceField", () => {
    const result = planManagedWarehouseAttributeMigration({
      legacyColumns: [
        legacyCol({
          columnName: "country",
          sourceField: "country",
          type: "dimension",
        }),
        legacyCol({
          columnName: "country_alias",
          sourceField: "country",
          type: "dimension",
        }),
      ],
      existingAttributes: [],
    });
    expect(result.additions.map((a) => a.property)).toEqual(["country"]);
  });
});
