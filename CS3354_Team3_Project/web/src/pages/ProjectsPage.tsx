/**
 * @author Saaqib Shaik - matches projects.html
 * @description All of the user's projects as customisable cards, with search, type and status filters and
 *   a "New project" button. Card color and order are saved per user; progress bars update live.
 * @traces SE-FR-16, SE-FR-17, SE-FR-18, UC-12, UC-13
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { CreateProjectModal } from '../features/projects/CreateProjectModal';
import { PROJECT_STATUSES, PROJECT_TYPES } from '../features/projects/model';
import { ProjectCard } from '../features/projects/ProjectCard';
import { projectController } from '../features/projects/projectController';
import { useProjectScope } from '../features/projects/ProjectScope';
import { Alert, EmptyState, Icon, PageHeader, Segmented, Spinner } from '../shared/ui';
import { toApiError } from '../shared/useSave';

export function ProjectsPage() {
  const { user } = useAuth();
  const { projects, loading, refresh, setCurrentProjectId } = useProjectScope();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | string>('all');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      projects.filter(
        (p) =>
          (type === 'all' || p.project_type === type) &&
          (!status || p.status === status) &&
          (!search.trim() || p.name.toLowerCase().includes(search.toLowerCase()) || p.description.toLowerCase().includes(search.toLowerCase())),
      ),
    [projects, type, status, search],
  );

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(toApiError(err).detail);
    }
  };

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'} you belong to`}
        actions={<button type="button" className="btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New project</button>}
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input pl-9" placeholder="Search projects" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search projects" />
        </div>
        <Segmented ariaLabel="Project type" value={type} onChange={setType} options={[{ value: 'all', label: 'All' }, ...PROJECT_TYPES.map((t) => ({ value: t.value, label: t.label }))]} />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">Any status</option>
          {PROJECT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      {error ? <div className="mb-4"><Alert onClose={() => setError(null)}>{error}</Alert></div> : null}
      {loading ? <Spinner /> : visible.length === 0 ? (
        <div className="card">
          <EmptyState title={projects.length ? 'No projects match your filters' : 'No projects yet'} action={<button type="button" className="btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New project</button>}>
            {projects.length ? 'Try a different search or filter.' : 'Create your first project to get started.'}
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => {
            const index = projects.findIndex((x) => x.id === p.id);
            return (
              <ProjectCard
                key={p.id}
                project={p}
                index={index}
                total={projects.length}
                onRecolor={(hex) => void act(() => projectController.customizeCard(p.id, { card_color: hex }))}
                onMove={(order) => void act(() => projectController.customizeCard(p.id, { card_order: order }))}
              />
            );
          })}
        </div>
      )}
      <CreateProjectModal
        open={creating}
        defaultType={user?.default_project_type ?? 'work'}
        onClose={() => setCreating(false)}
        onCreated={async (project) => {
          setCreating(false);
          await refresh();
          setCurrentProjectId(project.id);
          navigate(`/projects/${project.id}`);
        }}
      />
    </div>
  );
}
