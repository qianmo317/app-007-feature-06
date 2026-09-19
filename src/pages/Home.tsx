import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getAllPlans,
  savePlan,
  movePlanToTrash,
  getTrashedPlans,
  restorePlan,
  deleteTrashedPlan,
  type TrashedPlan,
} from '../db';
import { createEmptyPlan, clonePlan, generateId } from '../utils';
import type { Plan } from '../types';

type SortKey = 'updatedAt' | 'createdAt' | 'tables' | 'guests';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updatedAt', label: '按更新时间' },
  { key: 'createdAt', label: '按创建时间' },
  { key: 'tables', label: '按桌数' },
  { key: 'guests', label: '按人数' },
];

export default function Home() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [trash, setTrash] = useState<TrashedPlan[]>([]);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortAsc, setSortAsc] = useState(false);
  const [showTrash, setShowTrash] = useState(true);
  const navigate = useNavigate();

  const refresh = async () => {
    const [all, trashed] = await Promise.all([getAllPlans(), getTrashedPlans()]);
    setPlans(all);
    setTrash(trashed.sort((a, b) => b.deletedAt - a.deletedAt));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleNew = async () => {
    const plan = createEmptyPlan();
    await savePlan(plan);
    navigate(`/plan/${plan.id}`);
  };

  const handleCopy = async (plan: Plan) => {
    const copy = clonePlan(plan);
    copy.id = generateId();
    copy.name = `${copy.name} 副本`;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    await savePlan(copy);
    await refresh();
  };

  const handleDelete = async (plan: Plan) => {
    const capacity = plan.tables.reduce((n, t) => n + t.capacity, 0);
    const seated = plan.tables.reduce((n, t) => n + t.seatOrder.length, 0);
    const ok = confirm(
      `确定删除方案「${plan.name}」？\n` +
        `该方案包含 ${plan.tables.length} 张桌（共 ${capacity} 个座位）、${plan.guests.length} 位宾客（${seated} 位已排座）、${plan.rules.length} 条规则。\n` +
        `删除后将移入回收站，可随时从回收站恢复。`
    );
    if (!ok) return;
    await movePlanToTrash(plan.id);
    await refresh();
  };

  const handleRestore = async (id: string) => {
    await restorePlan(id);
    await refresh();
  };

  const handlePurge = async (entry: TrashedPlan) => {
    if (!confirm(`彻底删除方案「${entry.plan.name}」？删除后无法恢复。`)) return;
    await deleteTrashedPlan(entry.id);
    await refresh();
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const query = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    const matched = plans.filter(
      (p) =>
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.guests.some((g) => g.name.toLowerCase().includes(query))
    );
    const diff = (a: Plan, b: Plan) => {
      switch (sortKey) {
        case 'updatedAt':
          return a.updatedAt - b.updatedAt;
        case 'createdAt':
          return a.createdAt - b.createdAt;
        case 'tables':
          return a.tables.length - b.tables.length;
        case 'guests':
          return a.guests.length - b.guests.length;
      }
    };
    return matched.sort((a, b) => (sortAsc ? diff(a, b) : diff(b, a)));
  }, [plans, query, sortKey, sortAsc]);

  const matchedGuestNames = (plan: Plan): string[] =>
    query ? plan.guests.filter((g) => g.name.toLowerCase().includes(query)).map((g) => g.name) : [];

  return (
    <div className="home-container">
      <header className="home-header">
        <h1>婚宴座次编排器</h1>
        <button className="btn-primary" onClick={handleNew}>新建方案</button>
      </header>

      {plans.length > 0 && (
        <div className="home-toolbar">
          <input
            className="search-input"
            type="search"
            placeholder="搜索方案名或宾客姓名…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="sort-select"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <button className="sort-dir-btn" onClick={() => setSortAsc(!sortAsc)}>
            {sortAsc ? '升序 ↑' : '降序 ↓'}
          </button>
        </div>
      )}

      <div className="plans-list">
        {plans.length === 0 && (
          <div className="empty-state">
            <p>暂无方案，点击上方按钮创建</p>
          </div>
        )}
        {plans.length > 0 && filtered.length === 0 && (
          <div className="empty-state">
            <p>没有找到名称或宾客姓名包含「{search.trim()}」的方案</p>
            <p className="empty-hint">可能是名字对不上，换个关键词试试</p>
          </div>
        )}
        {filtered.map((plan) => {
          const matchedGuests = matchedGuestNames(plan);
          return (
            <div key={plan.id} className="plan-card" onClick={() => navigate(`/plan/${plan.id}`)}>
              <div className="plan-info">
                <h3>{plan.name}</h3>
                <p className="plan-meta">
                  {plan.tables.length} 桌 · {plan.guests.length} 人
                </p>
                <p className="plan-meta plan-dates">
                  创建于 {formatDate(plan.createdAt)} · 最后改动 {formatDate(plan.updatedAt)}
                </p>
                {matchedGuests.length > 0 && (
                  <p className="matched-guests">
                    匹配宾客：{matchedGuests.slice(0, 6).join('、')}
                    {matchedGuests.length > 6 ? ` 等 ${matchedGuests.length} 人` : ''}
                  </p>
                )}
              </div>
              <div className="plan-actions" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => handleCopy(plan)}>复制</button>
                <button onClick={() => handleDelete(plan)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {trash.length > 0 && (
        <div className="trash-section">
          <button className="trash-toggle" onClick={() => setShowTrash(!showTrash)}>
            回收站（{trash.length}）{showTrash ? '▲ 收起' : '▼ 展开'}
          </button>
          {showTrash && (
            <div className="trash-list">
              {trash.map((entry) => (
                <div key={entry.id} className="trash-item">
                  <div className="plan-info">
                    <h3>{entry.plan.name}</h3>
                    <p className="plan-meta">
                      {entry.plan.tables.length} 桌 · {entry.plan.guests.length} 人 · 删除于 {formatDate(entry.deletedAt)}
                    </p>
                  </div>
                  <div className="plan-actions">
                    <button onClick={() => handleRestore(entry.id)}>恢复</button>
                    <button onClick={() => handlePurge(entry)}>彻底删除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
