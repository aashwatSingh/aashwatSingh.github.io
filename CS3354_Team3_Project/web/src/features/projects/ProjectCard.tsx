/**
 * @author Saaqib Shaik
 * @description One project tile on the Projects screen (projects.html): color stripe, name, type, status,
 *   the user's role, live progress bar, deadline countdown and member count, plus controls to recolor the
 *   card and move it earlier / later in the user's own ordering.
 * @traces SE-FR-16, SE-FR-17, SE-FR-18, UC-13
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project } from '../../shared/types';
import { formatDate } from '../../shared/format';
import { Badge, Icon, ProgressBar, RoleBadge, StatusBadge } from '../../shared/ui';
import { ColorPicker } from './ColorPicker';
import { PROJECT_TYPES, deadlineCountdown } from './model';

interface Props {
  project: Project;
  index: number;
  total: number;
  onRecolor: (hex: string) => void;
  onMove: (newOrder: number) => void;
}

export function ProjectCard({ project, index, total, onRecolor, onMove }: Props) {
  const [picking, setPicking] = useState(false);
  const due = deadlineCountdown(project.deadline);
  const type = PROJECT_TYPES.find((t) => t.value === project.project_type);
  return (
    <article className="card group relative flex flex-col overflow-hidden transition hover:-translate-y-0.5 hover:shadow-pop">
      <div className="h-1.5 w-full" style={{ background: project.card_color }} aria-hidden />
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link to={`/projects/${project.id}`} className="line-clamp-2 font-semibold hover:text-brand">
              {project.name}
            </Link>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="neutral" icon={type?.icon}>{type?.label}</Badge>
              <StatusBadge status={project.status} />
              <RoleBadge role={project.my_role} />
            </div>
          </div>
          <div className="flex shrink-0 gap-0.5 opacity-70 transition group-hover:opacity-100">
            <button type="button" className="btn-ghost p-1.5" onClick={() => onMove(index - 1)} disabled={index === 0} aria-label="Move card earlier">
              <Icon name="chevron-left" />
            </button>
            <button type="button" className="btn-ghost p-1.5" onClick={() => onMove(index + 1)} disabled={index >= total - 1} aria-label="Move card later">
              <Icon name="chevron-right" />
            </button>
            <button type="button" className="btn-ghost p-1.5" onClick={() => setPicking((v) => !v)} aria-label="Change card color" aria-expanded={picking}>
              <Icon name="palette" />
            </button>
          </div>
        </div>
        {picking ? (
          <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
            <ColorPicker
              value={project.card_color}
              onChange={(hex) => {
                onRecolor(hex);
                setPicking(false);
              }}
            />
          </div>
        ) : null}
        <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-muted">{project.description || 'No description yet.'}</p>
        <div className="mt-4">
          <ProgressBar value={project.progress_pct} color={project.card_color} label={`${project.done_count}/${project.task_count} tasks done`} />
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
          <span className={`flex items-center gap-1 font-medium ${due.overdue ? 'text-danger' : due.soon ? 'text-warn' : ''}`}>
            <Icon name={due.overdue ? 'alert' : 'calendar'} className="h-3.5 w-3.5" />
            {due.text} · {formatDate(project.deadline, { year: undefined })}
          </span>
          <span className="flex items-center gap-1">
            <Icon name="users" className="h-3.5 w-3.5" /> {project.member_count}
          </span>
        </div>
      </div>
    </article>
  );
}
