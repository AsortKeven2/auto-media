function normalizeWorkWeight(value, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const weight = Number(value);
  return Number.isFinite(weight) && weight >= 0 ? weight : fallback;
}

/**
 * 按权重计算整批作品份额。maxPerWork 用于保证同一作品每轮最多出现一次。
 */
function buildWeightedWorkQuota(items, count, maxPerWork = Infinity) {
  const source = (Array.isArray(items) ? items : [])
    .map(item => ({ ...item, weight: normalizeWorkWeight(item.weight) }))
    .filter(item => item.weight > 0);
  const targetCount = Math.max(0, Math.floor(Number(count) || 0));
  if (!targetCount) return [];
  if (!source.length) throw new Error('没有权重大于 0 的可用合集配置');

  const parsedMax = Number(maxPerWork);
  const capacity = Number.isFinite(parsedMax)
    ? Math.max(0, Math.floor(parsedMax))
    : Infinity;
  if (capacity * source.length < targetCount) {
    throw new Error(`合集份额无法分配：${source.length} 个合集最多只能分配 ${capacity * source.length} 个名额`);
  }

  const allocations = source.map(item => ({ ...item, quota: 0, remaining: 0 }));
  let unallocated = targetCount;

  while (unallocated > 0) {
    const eligible = allocations.filter(item => item.quota < capacity);
    if (!eligible.length) throw new Error('合集份额不足，无法完成整批分配');

    const totalWeight = eligible.reduce((sum, item) => sum + item.weight, 0);
    const shares = eligible.map(item => {
      const available = capacity - item.quota;
      const exact = (unallocated * item.weight) / totalWeight;
      return {
        item,
        exact,
        base: Math.min(Math.floor(exact), available),
        remainder: exact - Math.floor(exact),
        saturated: exact >= available,
      };
    });

    for (const share of shares) {
      share.item.quota += share.base;
      unallocated -= share.base;
    }

    // 有作品触及单轮不重复上限时，先移除它，再重新分配溢出的份额。
    if (shares.some(share => share.saturated)) continue;

    const ranked = shares
      .filter(share => share.item.quota < capacity)
      .sort((a, b) => {
        if (b.remainder !== a.remainder) return b.remainder - a.remainder;
        if (b.item.weight !== a.item.weight) return b.item.weight - a.item.weight;
        return a.item.name.localeCompare(b.item.name, 'zh-Hans-CN');
      });
    for (let i = 0; i < unallocated; i++) {
      ranked[i].item.quota++;
    }
    unallocated = 0;
  }

  for (const item of allocations) item.remaining = item.quota;
  return allocations.filter(item => item.quota > 0);
}

/**
 * 从剩余整批份额中抽取一轮。必须本轮选中的作品会优先进入，其他位置按剩余份额随机。
 */
function takeWeightedWorkRound(allocations, count, roundsRemaining, random = Math.random) {
  const targetCount = Math.max(0, Math.floor(Number(count) || 0));
  const availableRounds = Math.max(0, Math.floor(Number(roundsRemaining) || 0));
  if (!targetCount) return [];
  if (!availableRounds) throw new Error('没有剩余轮次，无法继续分配合集');

  const active = (Array.isArray(allocations) ? allocations : [])
    .filter(item => Number(item.remaining) > 0);
  const totalRemaining = active.reduce((sum, item) => sum + item.remaining, 0);
  if (totalRemaining < targetCount || active.length < targetCount) {
    throw new Error(`剩余合集份额不足，当前轮需要 ${targetCount} 个合集`);
  }
  if (active.some(item => item.remaining > availableRounds)) {
    throw new Error('剩余合集份额无法在后续轮次内完成');
  }

  const selected = active.filter(item => item.remaining === availableRounds);
  if (selected.length > targetCount) {
    throw new Error('必须在本轮分配的合集数量超过本轮上限');
  }

  const selectedNames = new Set(selected.map(item => item.name));
  while (selected.length < targetCount) {
    const candidates = active.filter(item => !selectedNames.has(item.name));
    const totalWeight = candidates.reduce((sum, item) => sum + item.remaining, 0);
    let threshold = Math.min(Math.max(Number(random()) || 0, 0), 1) * totalWeight;
    let selectedItem = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      threshold -= candidate.remaining;
      if (threshold < 0) {
        selectedItem = candidate;
        break;
      }
    }
    selected.push(selectedItem);
    selectedNames.add(selectedItem.name);
  }

  for (const item of selected) item.remaining--;
  return selected;
}

module.exports = { normalizeWorkWeight, buildWeightedWorkQuota, takeWeightedWorkRound };
