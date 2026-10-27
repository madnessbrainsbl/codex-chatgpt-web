import assert from "node:assert/strict";

export function multipartRecords(parts: readonly string[]): any[] {
  const records = parts.flatMap(part => JSON.parse(part).records);
  const result: any[] = [];
  for (let offset = 0; offset < records.length;) {
    const record = records[offset];
    if (record.kind !== "fragment") { result.push(record); offset++; continue; }
    const fragments = records.slice(offset, offset + record.total_fragments);
    assert.equal(fragments.length, record.total_fragments);
    fragments.forEach((part, index) => {
      assert.equal(part.kind, "fragment");
      assert.equal(part.record_index, record.record_index);
      assert.equal(part.total_fragments, record.total_fragments);
      assert.equal(part.fragment_index, index);
    });
    result.push(JSON.parse(fragments.map(part => part.data).join("")));
    offset += fragments.length;
  }
  return result;
}
