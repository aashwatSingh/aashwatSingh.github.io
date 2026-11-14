/**
 * @author Aashwat Singh - matches tasks.html
 * @description The task board for the current project: To Do / In Progress / Review / Done columns with
 *   drag-and-drop (Task.moveTo). Moves appear instantly and are rolled back if the server refuses them or
 *   the connection fails (with Retry). Filters by text, assignee, tag and feature list. Only owners and
 *   managers see "New task"; members can drag only the tasks assigned to them.
 * @traces SE-FR-26, SE-FR-27, SE-FR-18, SE-NFR-04, SE-NFR-10, UC-18
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { useAuth } from '../features/auth/AuthProvider';
import { projectController } from '../features/projects/projectController';
import { useProjectScope } from '../features/projects/ProjectScope';
import { TaskCard } from '../features/tasks/TaskCard';
import { TaskForm } from '../features/tasks/TaskForm';
import { BOARD_COLUMNS, Membership, applyMove, canEditTask, filterTasks, groupByStatus, type TaskFilters } from '../features/tasks/model';
import { taskController } from '../features/tasks/taskController';
import { ApiError } from '../services/apiClient';
import { useRealtime } from '../services/realtimeClient';
import type { ProjectDetail, Task, TaskStatus } from '../shared/types';
import { Alert, EmptyState, Icon, PageHeader, RetryBanner, Spinner } from '../shared/ui';
import { toApiError } from '../shared/useSave';

export function BoardPage() {
  const { user } = useAuth();
  const { currentProjectId, loading: scopeLoading } = useProjectScope();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [filters, setFilters] = useState<TaskFilters>({ search: '', assignee: 'all', tag: '', listId: '' });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TaskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedMove, setFailedMove] = useState<{ taskId: string; status: TaskStatus; index: number; error: ApiError } | null>(null);
  const [creating, setCreating] = useState<TaskStatus | null>(null);

  const load = useCallback(async () => {
    if (!currentProjectId) return;
    try {
      const [p, t, tg] = await Promise.all([projectController.get(currentProjectId), taskController.list(currentProjectId), taskController.tags(currentProjectId)]);
      setProject(p);
      setTasks(t);
      setTags(tg);
      setError(null);
    } catch (err) {
      setError(toApiError(err).detail);
    }
  }, [currentProjectId]);

  useEffect(() => {
    setTasks(null);
    void load();
  }, [load]);

  useRealtime('task_changed', (d: { project_id: string }) => {
    if (d.project_id === currentProjectId && !dragId) void load();
  });

  const visible = useMemo(() => filterTasks(tasks ?? [], filters, user?.id), [tasks, filters, user?.id]);
  const columns = useMemo(() => groupByStatus(visible), [visible]);
  const lists = useMemo(() => new Map((project?.lists ?? []).map((l) => [l.id, l])), [project]);

  const commitMove = async (taskId: string, status: TaskStatus, index: number) => {
    if (!tasks) return;
    const before = tasks;
    setTasks(applyMove(tasks, taskId, status, index));
    try {
      await taskController.moveTo(taskId, index, status);
      setFailedMove(null);
    } catch (err) {
      setTasks(before); // snap back to the original column / position
      const apiErr = toApiError(err);
      if (apiErr.isConnectivity) setFailedMove({ taskId, status, index, error: apiErr });
      else setError(apiErr.detail);
    }
  };

  const onDragStart = (e: DragEvent<HTMLElement>, task: Task) => {
    setDragId(task.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  };

  const dropIndex = (e: DragEvent<HTMLElement>, status: TaskStatus): number => {
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-task-id]')).filter((el) => el.dataset.taskId !== dragId);
    const idx = cards.findIndex((el) => {
      const rect = el.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });
    const position = idx === -1 ? cards.length : idx;
    // Map the index among *visible* cards to the full column order used by the server.
    const fullColumn = groupByStatus((tasks ?? []).filter((t) => t.id !== dragId))[status];
    const anchor = cards[position]?.dataset.taskId;
    return anchor ? fullColumn.findIndex((t) => t.id === anchor) : fullColumn.length;
  };

  const onDrop = (e: DragEvent<HTMLElement>, status: TaskStatus) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setOverColumn(null);
    setDragId(null);
    if (!id) return;
    void commitMove(id, status, dropIndex(e, status));
  };

  if (scopeLoading) return <Spinner />;
  if (!currentProjectId) return <EmptyState title="No project selected" icon="board">Create or join a project to see its board.</EmptyState>;
  if (error && !tasks) return <Alert>{error}</Alert>;
  if (!tasks || !project) return <Spinner label="Loading board…" />;
  const canCreate = Membership.canAssignTasks(project.my_role);

  return (
    <div>
      <PageHeader
        title={`${project.name} · Board`}
        subtitle={canCreate ? 'Drag cards between columns. You can create and assign tasks.' : 'Drag the cards assigned to you. Owners and managers create and assign tasks.'}
        actions={canCreate ? <button type="button" className="btn-primary" onClick={() => setCreating('todo')}><Icon name="plus" /> New task</button> : null}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input pl-9" placeholder="Search tasks" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} aria-label="Search tasks" />
        </div>
        <select className="input w-auto" value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })} aria-label="Filter by assignee">
          <option value="all">Everyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {project.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
        </select>
        <select className="input w-auto" value={filters.listId} onChange={(e) => setFilters({ ...filters, listId: e.target.value })} aria-label="Filter by feature list">
          <option value="">All lists</option>
          {project.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="input w-auto" value={filters.tag} onChange={(e) => setFilters({ ...filters, tag: e.target.value })} aria-label="Filter by tag">
          <option value="">All tags</option>
          {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
      </div>
      <div className="mb-4 space-y-3">
        {error ? <Alert onClose={() => setError(null)}>{error} The card was moved back.</Alert> : null}
        <RetryBanner error={failedMove?.error ?? null} onRetry={() => failedMove && void commitMove(failedMove.taskId, failedMove.status, failedMove.index)} onCancel={() => setFailedMove(null)} />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {BOARD_COLUMNS.map((col) => (
          <section
            key={col.status}
            aria-label={`${col.label} column`}
            onDragOver={(e) => { e.preventDefault(); setOverColumn(col.status); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverColumn(null); }}
            onDrop={(e) => onDrop(e, col.status)}
            className={`flex min-h-[320px] flex-col rounded-xl border bg-surface-2/60 p-3 transition ${overColumn === col.status ? 'border-brand bg-brand/5' : 'border-line'}`}
          >
            <header className="mb-3 flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold">{col.label} <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{columns[col.status].length}</span></h2>
              {canCreate ? (
                <button type="button" className="btn-ghost p-1" onClick={() => setCreating(col.status)} aria-label={`Add task to ${col.label}`}><Icon name="plus" /></button>
              ) : null}
            </header>
            <div className="flex flex-1 flex-col gap-2">
              {columns[col.status].map((task) => (
                <TaskCard key={task.id} task={task} list={task.list_id ? lists.get(task.list_id) : undefined} draggable={canEditTask(project.my_role, task, user?.id)} onDragStart={onDragStart} />
              ))}
              {columns[col.status].length === 0 ? <p className="rounded-lg border border-dashed border-line py-8 text-center text-xs text-muted">Drop tasks here</p> : null}
            </div>
          </section>
        ))}
      </div>
      {creating ? (
        <TaskForm
          open
          onClose={() => setCreating(null)}
          projectId={project.id}
          role={project.my_role}
          members={project.members}
          lists={project.lists}
          defaultStatus={creating}
          onSaved={() => { setCreating(null); void load(); }}
        />
      ) : null}
    </div>
  );
}
