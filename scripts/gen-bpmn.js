#!/usr/bin/env node
// basic_design.md の bpmn_descriptions（mermaid）から process.bpmn を生成する。
// purchase-management と同じ mermaid-bpmn-converter 経由の正規生成ルート。
// 使い方: node scripts/gen-bpmn.js  （リポジトリ直下の mermaid-bpmn-converter-main を使用）
'use strict';

const fs = require('fs');
const path = require('path');

const CONV = path.join(__dirname, '..', '..', '..', 'mermaid-bpmn-converter-main');
const { parseMermaid } = require(path.join(CONV, 'src', 'parsers', 'mermaid-parser'));
const { convertMermaidToIntermediate } = require(path.join(CONV, 'src', 'converters', 'intermediate-converter'));
const { generateBPMN } = require(path.join(CONV, 'src', 'generators', 'bpmn-generator'));

const specDir = path.join(__dirname, '..', 'specs', 'purchase-kaikei');
const bdPath = path.join(specDir, 'basic_design.md');
const outPath = path.join(specDir, 'process.bpmn');

const bd = fs.readFileSync(bdPath, 'utf8');
const m = bd.match(/## bpmn_descriptions[\s\S]*?```mermaid\n([\s\S]*?)```/);
if (!m) {
  console.error('bpmn_descriptions の mermaid ブロックが見つかりません');
  process.exit(1);
}

const ir = convertMermaidToIntermediate(parseMermaid(m[1]));
// レーン（縦型スイムレーン）。flowNodeRef は mermaid のノード id（生成時に BPMN id へ再マップされる）
ir.lanes = [
  { id: 'Lane_Applicant', name: '申請者', flowNodeRefs: ['S', 'T1'] },
  { id: 'Lane_Manager', name: '部長', flowNodeRefs: ['A1', 'G1', 'R1'] },
  { id: 'Lane_Admin', name: '管理担当', flowNodeRefs: ['J1', 'T4', 'T5', 'T6', 'T8', 'E1'] },
];
ir.featureName = 'PURCHASEKAIKEI';
ir.processName = '購買会計プロセス';
ir.processDocumentation =
  '購買会計プロセス (v2・1段承認・会計エンジン内蔵)\n' +
  '部長の 1 段承認。却下時は理由を記録し、同一申請書で再申請できる (履歴保持)。\n' +
  '検収は分割可。検収ごとに支払予定を計上し、内蔵会計エンジンで仕訳 (仕入高/買掛金) を自動計上。\n' +
  '支払実行時も仕訳 (買掛金/普通預金) を自動計上。外部 API 連携はない。';

const bpmn = generateBPMN(ir, { tecnosFeat: true, documentation: true });
fs.writeFileSync(outPath, bpmn, 'utf8');
console.log(`generated: ${outPath} (${bpmn.length} bytes)`);
