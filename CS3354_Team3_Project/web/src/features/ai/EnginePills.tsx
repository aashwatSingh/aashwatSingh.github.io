/**
 * @author Aashwat Singh (ForgeAI)
 * @description The two small pills that say which engine produced a ForgeAI answer or suggestion:
 *   "Nemotron Super 49B" + "Live NIM" when NVIDIA's model answered, or "Nemotron offline" + "Local Engine"
 *   when the built-in rules answered. A local answer is never shown as coming from Nemotron.
 * @traces SE-NFR-02, SE-NFR-11, UC-21
 */
import { Badge } from '../../shared/ui';
import { engineBadge, type AiStatus } from './model';

export function EnginePills({ status }: { status: Pick<AiStatus, 'model' | 'mode'> | null }) {
  const badge = engineBadge(status);
  return (
    <span className="flex flex-wrap items-center gap-1.5" title={badge.description} data-testid="forgeai-engine">
      <Badge tone="accent" icon="sparkle">{badge.model}</Badge>
      <Badge tone={badge.tone}>{badge.mode}</Badge>
      <span className="sr-only">{badge.description}</span>
    </span>
  );
}
