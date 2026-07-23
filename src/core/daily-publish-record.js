const fs = require('fs');
const path = require('path');

const PUBLISH_RECORD_DIR = path.join(__dirname, '../..', 'publish_record');

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeWorksCount(works = {}) {
  const result = {};
  for (const [work, count] of Object.entries(works)) {
    const value = Number(count) || 0;
    result[work] = Math.max(0, value);
  }
  return result;
}

function sumWorks(works = {}) {
  return Object.values(works).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function getDailyRecordPath(recordDir = PUBLISH_RECORD_DIR, dateKey = getLocalDateKey()) {
  return path.join(recordDir, `baijiahao-${dateKey}.json`);
}

function deleteOldDailyRecords(recordDir, todayPath) {
  if (!fs.existsSync(recordDir)) return [];

  const deleted = [];
  for (const file of fs.readdirSync(recordDir)) {
    if (!/^baijiahao-\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    const filePath = path.join(recordDir, file);
    if (path.resolve(filePath) !== path.resolve(todayPath)) {
      fs.unlinkSync(filePath);
      deleted.push(file);
    }
  }
  return deleted;
}

function writeDailyRecord(recordPath, record) {
  record.updated_at = new Date().toISOString();
  record.remaining_total = sumWorks(record.works);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

function normalizeRounds(rounds, fallback = 1) {
  return Math.max(1, parseInt(rounds, 10) || fallback);
}

function loadOrCreateDailyRecord(sourceWorks, opts = {}) {
  const recordDir = path.resolve(opts.recordDir || PUBLISH_RECORD_DIR);
  const dateKey = opts.dateKey || getLocalDateKey();
  const recordPath = getDailyRecordPath(recordDir, dateKey);

  if (fs.existsSync(recordPath)) {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    record.works = normalizeWorksCount(record.works || {});
    record.remaining_total = sumWorks(record.works);
    const hadRoundFields = 'rounds_total' in record || 'rounds_completed' in record || 'base_batch_size' in record;
    delete record.rounds_total;
    delete record.rounds_completed;
    delete record.base_batch_size;
    if (hadRoundFields) writeDailyRecord(recordPath, record);
    return { record, recordPath, created: false, deletedOldRecords: [] };
  }

  fs.mkdirSync(recordDir, { recursive: true });
  const deletedOldRecords = deleteOldDailyRecords(recordDir, recordPath);

  const works = normalizeWorksCount(sourceWorks);
  const record = {
    date: dateKey,
    source: 'config.json.works',
    created_at: new Date().toISOString(),
    updated_at: '',
    total: sumWorks(works),
    remaining_total: sumWorks(works),
    works,
  };
  writeDailyRecord(recordPath, record);
  return { record, recordPath, created: true, deletedOldRecords };
}

function getDailyBatchPlan(record, rounds) {
  const roundsTotal = normalizeRounds(rounds, 1);
  const total = Number(record.total) || sumWorks(record.works);
  const remainingTotal = sumWorks(record.works);
  const baseBatchSize = Math.floor(total / roundsTotal);
  const isFinalRound = baseBatchSize < 1 || (remainingTotal - baseBatchSize) < baseBatchSize;
  const batchSize = isFinalRound
    ? remainingTotal
    : Math.min(baseBatchSize, remainingTotal);

  return {
    roundsTotal,
    baseBatchSize,
    batchSize,
    isFinalRound,
    remainingTotal,
  };
}

function buildDailyBatchEntries(record, batchSize) {
  const remaining = Object.entries(record.works || {}).map(([work, count], index) => ({
    work,
    count: Number(count) || 0,
    index,
  }));
  const selected = new Map();

  for (let i = 0; i < batchSize; i++) {
    remaining.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.index - b.index;
    });

    const next = remaining.find(item => item.count > 0);
    if (!next) break;

    selected.set(next.work, (selected.get(next.work) || 0) + 1);
    next.count--;
  }

  return [...selected.entries()];
}

function decrementDailyRecord(recordPath, record, work) {
  const current = Number(record.works[work]) || 0;
  record.works[work] = Math.max(0, current - 1);
  writeDailyRecord(recordPath, record);
  return record.works[work];
}

function ensureDailyCategoryQuota(recordPath, record, buildCategoryPlan) {
  if (!Array.isArray(record.category_queue)) {
    const total = Number(record.total) || sumWorks(record.works);
    const remainingTotal = sumWorks(record.works);
    const consumed = Math.max(0, total - remainingTotal);
    const fullQueue = buildCategoryPlan(total);
    record.category_total = total;
    record.category_queue = fullQueue.slice(consumed);
    writeDailyRecord(recordPath, record);
    return { created: true, total, remaining: record.category_queue.length };
  }

  record.category_queue = record.category_queue.filter(Boolean);
  record.category_total = Number(record.category_total) || record.category_queue.length;
  return { created: false, total: record.category_total, remaining: record.category_queue.length };
}

function peekDailyCategoryPlan(record, count) {
  const limit = Math.max(0, Math.floor(Number(count) || 0));
  return Array.isArray(record.category_queue)
    ? record.category_queue.slice(0, limit)
    : [];
}

function consumeDailyCategoryPlan(recordPath, record, count) {
  const used = Math.max(0, Math.floor(Number(count) || 0));
  if (!Array.isArray(record.category_queue)) record.category_queue = [];
  record.category_queue.splice(0, used);
  writeDailyRecord(recordPath, record);
  return record.category_queue.length;
}

module.exports = {
  PUBLISH_RECORD_DIR,
  loadOrCreateDailyRecord,
  getDailyBatchPlan,
  buildDailyBatchEntries,
  decrementDailyRecord,
  ensureDailyCategoryQuota,
  peekDailyCategoryPlan,
  consumeDailyCategoryPlan,
};
