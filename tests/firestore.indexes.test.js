const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Firestore Composite Indexes Configuration', () => {
  const filePath = path.resolve(__dirname, '..', 'firestore.indexes.json');

  it('firestore.indexes.json が存在し、有効なJSONとしてパース可能', () => {
    assert.ok(fs.existsSync(filePath), 'firestore.indexes.json が存在しません');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.doesNotThrow(() => {
      JSON.parse(content);
    }, 'firestore.indexes.json のJSONパースに失敗しました');
  });

  it('indexes配列およびfieldOverrides配列が存在する', () => {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(Array.isArray(json.indexes), 'indexes は配列である必要があります');
    assert.ok(Array.isArray(json.fieldOverrides), 'fieldOverrides は配列である必要があります');
  });

  it('notification_tokens index が exactly 1件定義されている', () => {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const tokenIndexes = json.indexes.filter(
      (idx) => idx.collectionGroup === 'notification_tokens'
    );
    assert.equal(tokenIndexes.length, 1, 'notification_tokens のインデックスが1件である必要があります');
  });

  it('notification_tokens index の queryScope が COLLECTION である', () => {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const tokenIndex = json.indexes.find(
      (idx) => idx.collectionGroup === 'notification_tokens'
    );
    assert.equal(tokenIndex.queryScope, 'COLLECTION', 'queryScope は COLLECTION である必要があります');
  });

  it('notification_tokens index のフィールド順序とorderが正確に一致し、余分なフィールドがない', () => {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const tokenIndex = json.indexes.find(
      (idx) => idx.collectionGroup === 'notification_tokens'
    );
    const expectedFields = [
      { fieldPath: 'enabled', order: 'ASCENDING' },
      { fieldPath: 'schema_version', order: 'ASCENDING' },
      { fieldPath: 'updated_at', order: 'ASCENDING' },
    ];

    assert.equal(
      tokenIndex.fields.length,
      expectedFields.length,
      `フィールド数は ${expectedFields.length} 件である必要があります（余分なフィールドは禁止）`
    );

    expectedFields.forEach((expected, i) => {
      const actual = tokenIndex.fields[i];
      assert.ok(actual, `インデックス ${i} にフィールドが存在しません`);
      assert.equal(
        actual.fieldPath,
        expected.fieldPath,
        `フィールド[${i}] の fieldPath は "${expected.fieldPath}" である必要があります (actual: "${actual.fieldPath}")`
      );
      assert.equal(
        actual.order,
        expected.order,
        `フィールド[${i}] の order は "${expected.order}" である必要があります (actual: "${actual.order}")`
      );
    });
  });
});
