/**
 * @author Aashwat Singh - matches people.html
 * @description The project's people: name, username, email, role, open tasks and join date. Owners and
 *   managers can invite people, change roles (never leaving the project without an owner) and remove members
 *   while reassigning their open tasks; anyone can leave a project. Changes apply immediately.
 * @traces SE-FR-30, SE-NFR-11, UC-19, UC-20
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { InviteMemberModal } from '../features/members/InviteMemberModal';
import { ReassignTasksModal } from '../features/members/ReassignTasksModal';
import { RoleSelect } from '../features/members/RoleSelect';
import { memberController } from '../features/members/memberController';
import { ProjectPicker, useProjectScope } from '../features/projects/ProjectScope';
import { useRealtime } from '../services/realtimeClient';
import { isManager } from '../shared/permissions';
import type { Member, Role } from '../shared/types';
import { formatDate } from '../shared/format';
import { Alert, Avatar, Card, EmptyState, Icon, PageHeader, RoleBadge, Spinner } from '../shared/ui';
import { toApiError } from '../shared/useSave';

export function PeoplePage() {
  const { user } = useAuth();
  const { currentProject, loading, refresh } = useProjectScope();
  const navigate = useNavigate();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!currentProject) return;
    try {
      setMembers(await memberController.list(currentProject.id));
    } catch (err) {
      setError(toApiError(err).detail);
    }
  }, [currentProject]);

  useEffect(() => { setMembers(null); void load(); }, [currentProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime('membership_changed', (d: { project_id: string }) => d.project_id === currentProject?.id && void load());

  if (loading) return <Spinner />;
  if (!currentProject) return <EmptyState title="No project selected" icon="users" />;
  const callerRole = currentProject.my_role;
  const manager = isManager(callerRole);

  const changeRole = async (m: Member, role: Role) => {
    setError(null);
    setNotice(null);
    try {
      await memberController.changeRole(currentProject.id, m.user_id, role);
      setNotice(`${m.display_name} is now ${role === 'owner' ? 'an' : 'a'} ${role}.`);
      await load();
      if (m.user_id === user?.id) await refresh();
    } catch (err) {
      setError(toApiError(err).detail);
      await load(); // put the select back to the saved role
    }
  };

  const leave = async () => {
    if (!user || !window.confirm(`Leave "${currentProject.name}"? Your open tasks will become unassigned.`)) return;
    try {
      await memberController.remove(currentProject.id, user.id);
      await refresh();
      navigate('/projects');
    } catch (err) {
      setError(toApiError(err).detail);
    }
  };

  const visible = (members ?? []).filter((m) => !search.trim() || `${m.display_name} ${m.username} ${m.email}`.toLowerCase().includes(search.toLowerCase()));
  const counts = { owner: 0, manager: 0, member: 0 };
  (members ?? []).forEach((m) => (counts[m.role] += 1));

  return (
    <div>
      <PageHeader
        title="People"
        subtitle={`${members?.length ?? 0} people in ${currentProject.name} · ${counts.owner} owner${counts.owner === 1 ? '' : 's'}, ${counts.manager} manager${counts.manager === 1 ? '' : 's'}, ${counts.member} member${counts.member === 1 ? '' : 's'}`}
        actions={
          <>
            <ProjectPicker />
            {manager ? <button type="button" className="btn-primary" onClick={() => setInviting(true)}><Icon name="plus" /> Invite</button> : null}
          </>
        }
      />
      <div className="mb-4 space-y-3">
        {error ? <Alert onClose={() => setError(null)}>{error}</Alert> : null}
        {notice ? <Alert tone="ok" onClose={() => setNotice(null)}>{notice}</Alert> : null}
        {!manager ? <Alert tone="info">Only owners and managers can invite people, change roles or remove members.</Alert> : null}
      </div>
      <Card bodyClass="p-0">
        <div className="border-b border-line p-3">
          <div className="relative max-w-sm">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input className="input pl-9" placeholder="Search people" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search people" />
          </div>
        </div>
        {members === null ? <Spinner /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-2">
                <tr><th className="table-head">Person</th><th className="table-head">Email</th><th className="table-head">Role</th><th className="table-head text-right">Open tasks</th><th className="table-head">Joined</th><th className="table-head w-28" /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visible.map((m) => {
                  const isSelf = m.user_id === user?.id;
                  const canRemove = !isSelf && manager && (m.role !== 'owner' || callerRole === 'owner');
                  return (
                    <tr key={m.user_id}>
                      <td className="table-cell">
                        <div className="flex items-center gap-3">
                          <Avatar name={m.display_name} url={m.avatar_url} />
                          <div><p className="font-medium">{m.display_name}{isSelf ? <span className="ml-1 text-xs text-muted">(you)</span> : null}</p><p className="text-xs text-muted">@{m.username}</p></div>
                        </div>
                      </td>
                      <td className="table-cell text-muted">{m.email}</td>
                      <td className="table-cell">{manager ? <RoleSelect value={m.role} callerRole={callerRole} onChange={(r) => void changeRole(m, r)} label={`Role for ${m.display_name}`} /> : <RoleBadge role={m.role} />}</td>
                      <td className="table-cell text-right tabular-nums">{m.open_task_count}</td>
                      <td className="table-cell whitespace-nowrap text-muted">{formatDate(m.joined_at)}</td>
                      <td className="table-cell text-right">
                        {canRemove ? <button type="button" className="btn-ghost px-2 py-1 text-xs hover:text-danger" onClick={() => setRemoving(m)}><Icon name="trash" className="h-3.5 w-3.5" /> Remove</button> : null}
                        {isSelf ? <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => void leave()}><Icon name="logout" className="h-3.5 w-3.5" /> Leave</button> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <InviteMemberModal open={inviting} projectId={currentProject.id} callerRole={callerRole} onClose={() => setInviting(false)} onInvited={(m) => { setInviting(false); setNotice(`${m.display_name} was added as ${m.role}.`); void load(); }} />
      <ReassignTasksModal open={!!removing} projectId={currentProject.id} member={removing} members={members ?? []} onClose={() => setRemoving(null)} onRemoved={(msg) => { setRemoving(null); setNotice(msg); void load(); }} />
    </div>
  );
}
