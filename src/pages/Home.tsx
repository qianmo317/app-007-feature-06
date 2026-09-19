import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getAllPlans,
  savePlan,
  movePlanToTrash,
  getAllTrashed,
  restoreTrashedPlan,
  purgeTrashedPlan,
  emptyTrash,
  TRASH_TTL_MS,
} from '../db';
import { createEmptyPlan, clonePlan, generateId } from '../utils';
import type { Plan, TrashedPlan } from '../types';

type SortKey = 'updatedAt' | 'createdAt' | 'tables' | 'guests';

export default function Home() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [trashed, setTrashed] = useState<TrashedPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const navigate = useNavigate();

  const refresh = async () => {
    const [allPlans, allTrashed] = await Promise.all([getAllPlans(), getAllTrashed()]);
    setPlans(allPlans);
    setTrashed(allTrashed);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const keyword = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    const matched = keyword
      ? plans.filter(
          (p) =>
            p.name.toLowerCase().includes(keyword) ||
            p.guests.some((g) => g.name.toLowerCase().includes(keyword)),
        )
      : plans;

    const valueOf = (p: Plan): number => {
      switch (sortKey) {
        case 'tables':
          return p.tables.length;
        case 'guests':
          return p.guests.length;
        case 'createdAt':
          return p.createdAt;
        case 'updatedAt':
          return p.updatedAt;
      }
    };

    return matched.slice().sort((a, b) => {
      const primary = valueOf(a) - valueOf(b);
      if (primary !== 0) return sortDir === 'asc' ? primary : -primary;
      // 数值相同时用更新时间兜底，保证顺序稳定
      return b.updatedAt - a.updatedAt;
    });
  }, [plans, keyword, sortKey, sortDir]);

  const handleNew = async () => {
    const plan = createEmptyPlan();
    await savePlan(plan);
    navigate(`/plan/${plan.id}`);
  };

  const handleCopy = async (plan: Plan) => {
    const copy = clonePlan(plan);
    const now = Date.now();
    copy.id = generateId();
    copy.name = `${copy.name} 副本`;
    copy.createdAt = now;
    copy.updatedAt = now;
    await savePlan(copy);
    setPlans(await getAllPlans());
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await movePlanToTrash(deleteTarget.id);
    setDeleteTarget(null);
    refresh();
  };

  const handleRestore = async (id: string) => {
    await restoreTrashedPlan(id);
    refresh();
  };

  const handlePurge = async (id: string) => {
    if (!confirm('彻底删除后无法再从回收站恢复，确定继续？')) return;
    await purgeTrashedPlan(id);
    refresh();
  };

  const handleEmptyTrash = async () => {
    if (!confirm(`确定清空回收站吗？${trashed.length} 份方案将被彻底删除，无法恢复。`)) return;
    await emptyTrash();
    refresh();
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const sortLabels: Record<SortKey, string> = {
    updatedAt: '更新时间',
    createdAt: '创建时间',
    tables: '桌数',
    guests: '人数',
  };

  const getDeleteStats = (p: Plan) => {
    const capacity = p.tables.reduce((sum, t) => sum + t.capacity, 0);
    const seatedIds = new Set(p.tables.flatMap((t) => t.seatOrder));
    const seated = p.guests.filter((g) => seatedIds.has(g.id)).length;
    return { capacity, seated, unassigned: p.guests.length - seated };
  };

  return (
    <div className="home-container">
      <header className="home-header">
        <h1>婚宴座次编排器</h1>
        <button className="btn-primary" onClick={handleNew}>新建方案</button>
      </header>

      <div className="home-toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="搜索方案名或宾客姓名"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="sort-select"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          aria-label="排序字段"
        >
          <option value="updatedAt">按更新时间</option>
          <option value="createdAt">按创建时间</option>
          <option value="tables">按桌数</option>
          <option value="guests">按人数</option>
        </select>
        <button
          className="sort-dir-btn"
          onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          title={sortDir === 'desc' ? '当前：从多到少 / 从新到旧' : '当前：从少到多 / 从旧到新'}
        >
          {sortDir === 'desc' ? '降序 ↓' : '升序 ↑'}
        </button>
      </div>

      <p className="list-hint">
        {loading
          ? '正在加载方案…'
          : keyword
            ? `匹配「${query.trim()}」的方案共 ${filtered.length} 份`
            : `共 ${plans.length} 份方案，按${sortLabels[sortKey]}${sortDir === 'desc' ? '降序' : '升序'}排列`}
      </p>

      <div className="plans-list">
        {!loading && plans.length === 0 && !keyword && (
          <div className="empty-state">
            <p>暂无方案，点击上方「新建方案」按钮创建</p>
          </div>
        )}
        {!loading && plans.length > 0 && filtered.length === 0 && (
          <div className="empty-state">
            <p>没有找到名称或宾客姓名包含「{query.trim()}」的方案</p>
            <p className="empty-state-sub">本地一共有 {plans.length} 份方案，但没有一份对得上这个关键字，请检查是不是名字写错了</p>
            <button className="clear-search-btn" onClick={() => setQuery('')}>清除搜索条件</button>
          </div>
        )}
        {filtered.map((plan) => {
          const matchedGuests = keyword
            ? plan.guests.filter((g) => g.name.toLowerCase().includes(keyword)).map((g) => g.name)
            : [];
          return (
            <div key={plan.id} className="plan-card" onClick={() => navigate(`/plan/${plan.id}`)}>
              <div className="plan-info">
                <h3>{plan.name}</h3>
                {matchedGuests.length > 0 && (
                  <p className="match-guests">
                    匹配宾客：{matchedGuests.slice(0, 3).join('、')}
                    {matchedGuests.length > 3 ? ` 等 ${matchedGuests.length} 人` : ''}
                  </p>
                )}
                <p className="plan-meta">
                  {plan.tables.length} 桌 · {plan.guests.length} 人
                </p>
                <p className="plan-time">
                  创建于 {formatDate(plan.createdAt)} · 最后改动于 {formatDate(plan.updatedAt)}
                </p>
              </div>
              <div className="plan-actions" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => handleCopy(plan)}>复制</button>
                <button className="delete-btn" onClick={() => setDeleteTarget(plan)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {trashed.length > 0 && (
        <div className="trash-section">
          <div className="trash-header" onClick={() => setShowTrash((s) => !s)}>
            <h3>回收站（{trashed.length}）</h3>
            <span className="trash-toggle">
              {showTrash ? '收起 ▲' : '展开 ▼'}
              <button
                className="empty-trash-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleEmptyTrash();
                }}
              >
                清空回收站
              </button>
            </span>
          </div>
          {showTrash && (
            <div className="trash-list">
              <p className="trash-tip">删除的方案会在回收站保留 30 天，期间可以随时恢复；超期自动彻底清除。</p>
              {trashed.map((p) => {
                const daysLeft = Math.max(
                  0,
                  Math.ceil((p.deletedAt + TRASH_TTL_MS - Date.now()) / (24 * 60 * 60 * 1000)),
                );
                return (
                  <div key={p.id} className="trash-item">
                    <div className="trash-info">
                      <span className="trash-name">{p.name}</span>
                      <span className="trash-meta">
                        {p.tables.length} 桌 · {p.guests.length} 人 · 删除于 {formatDate(p.deletedAt)} · 还可恢复 {daysLeft} 天
                      </span>
                    </div>
                    <div className="trash-actions">
                      <button onClick={() => handleRestore(p.id)}>恢复</button>
                      <button className="delete-btn" onClick={() => handlePurge(p.id)}>彻底删除</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除方案「{deleteTarget.name}」？</h3>
            {(() => {
              const stats = getDeleteStats(deleteTarget);
              return (
                <div className="delete-summary">
                  <p>这份方案底下还牵着以下数据：</p>
                  <ul>
                    <li>桌位 <b>{deleteTarget.tables.length}</b> 桌，共 <b>{stats.capacity}</b> 个座位，其中已安排 <b>{stats.seated}</b> 人入座</li>
                    <li>宾客名单 <b>{deleteTarget.guests.length}</b> 人{stats.unassigned > 0 ? `，其中 ${stats.unassigned} 人尚未入桌` : ''}</li>
                    <li>编排规则 <b>{deleteTarget.rules.length}</b> 条</li>
                  </ul>
                  <p className="delete-note">删除后方案会移入回收站，30 天内可以从首页底部找回；超过 30 天会被彻底清除。</p>
                </div>
              );
            })()}
            <div className="modal-actions">
              <button onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="btn-danger" onClick={handleDelete}>移入回收站</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
