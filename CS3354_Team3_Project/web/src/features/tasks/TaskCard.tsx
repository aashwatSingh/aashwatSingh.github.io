/**
 * @author Aashwat Singh
 * @description A task card on the board (tasks.html): title, priority, tags, assignee, due date, soft
 *   deadline progress and comment count. Cards the user may move are draggable; others show a lock icon.
 * @traces SE-FR-26, SE-FR-27, SE-FR-07, UC-18
 */
import type { DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Task, TaskList } from '../../shared/types';
import { formatDate } from '../../shared/format';
import { Avatar, Badge, Icon, PriorityBadge } from '../../shared/ui';
import { SoftDeadlineBadge } from '../soft-deadlines/SoftDeadlineBadge';
import { isOverdue } from './model';

interface Props {
  task: Task;
  list?: TaskList;
  draggable: boolean;
  onDragStart: (e: DragEvent<HTMLElement>, task: Task) => void;
}

export function TaskCard({ task, list, draggable, onDragStart }: Props) {
  const overdue = isOverdue(task);
  return (
    <article
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, task)}
      className={`card group p-3 text-sm transition hover:shadow-pop ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      aria-label={task.title}
      data-task-id={task.id}
    >
      <div className="flex items-start justify-between gap-2">
        <Link to={`/tasks/${task.id}`} className="font-medium leading-snug hover:text-brand" draggable={false}>
          {task.title}
        </Link>
        {!draggable ? <Icon name="lock" className="h-3.5 w-3.5 shrink-0 text-muted" title="Only the assignee or a manager can move this task" /> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={task.priority} />
        {list ? <Badge tone="neutral" icon="layout">{list.name}</Badge> : null}
        {task.tags.slice(0, 3).map((tag) => (
          <Badge key={tag} tone="accent">#{tag}</Badge>
        ))}
      </div>
      {task.soft_deadlines_total > 0 ? (
        <div className="mt-2">
          <SoftDeadlineBadge total={task.soft_deadlines_total} done={task.soft_deadlines_done} nextAt={task.next_soft_deadline_at} />
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <span className={`flex items-center gap-1 ${overdue ? 'font-semibold text-danger' : ''}`}>
          {task.due_date ? (
            <>
              <Icon name={overdue ? 'alert' : 'calendar'} className="h-3.5 w-3.5" />
              {overdue ? 'Overdue · ' : ''}
              {formatDate(task.due_date, { year: undefined })}
            </>
          ) : (
            'No due date'
          )}
        </span>
        <span className="flex items-center gap-2">
          {task.comment_count > 0 ? (
            <span className="flex items-center gap-0.5"><Icon name="comment" className="h-3.5 w-3.5" />{task.comment_count}</span>
          ) : null}
          {task.assignee ? <Avatar name={task.assignee.display_name || task.assignee.username} url={task.assignee.avatar_url} size="h-6 w-6" /> : <span className="italic">Unassigned</span>}
        </span>
      </div>
    </article>
  );
}
