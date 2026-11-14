/**
 * @author Tyler Gaines
 * @description Light / dark theme switch and the color-blindness palette picker, each with a live preview
 *   of the status colors so the user can see the difference before saving.
 * @traces SE-FR-14, SE-FR-15
 */
import type { ColorBlindMode, Theme } from '../../shared/types';
import { Badge, Icon } from '../../shared/ui';

export const COLOR_BLIND_OPTIONS: { value: ColorBlindMode; label: string; hint: string }[] = [
  { value: 'none', label: 'Standard colors', hint: 'Default palette' },
  { value: 'protanopia', label: 'Protanopia', hint: 'Red-weak: blue / orange palette' },
  { value: 'deuteranopia', label: 'Deuteranopia', hint: 'Green-weak: blue / orange palette' },
  { value: 'tritanopia', label: 'Tritanopia', hint: 'Blue-yellow weak: teal / magenta palette' },
  { value: 'high_contrast', label: 'High contrast', hint: 'Stronger text, borders and focus rings' },
];

export function ThemeToggle({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {(['light', 'dark'] as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          aria-pressed={value === t}
          className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${value === t ? 'border-brand ring-2 ring-brand/30' : 'border-line hover:bg-surface-2'}`}
        >
          <span className={`rounded-lg p-2 ${t === 'dark' ? 'bg-slate-900 text-indigo-300' : 'bg-amber-50 text-amber-500'}`}>
            <Icon name={t === 'dark' ? 'moon' : 'sun'} className="h-5 w-5" />
          </span>
          <span>
            <span className="block text-sm font-semibold">{t === 'dark' ? 'Dark' : 'Light'}</span>
            <span className="block text-xs text-muted">{t === 'dark' ? 'Easy on the eyes at night' : 'Bright and crisp'}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ColorBlindPicker({ value, onChange }: { value: ColorBlindMode; onChange: (m: ColorBlindMode) => void }) {
  return (
    <div className="space-y-2" role="radiogroup" aria-label="Color vision mode">
      {COLOR_BLIND_OPTIONS.map((o) => (
        <label
          key={o.value}
          className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-4 py-3 ${value === o.value ? 'border-brand bg-brand/5' : 'border-line hover:bg-surface-2'}`}
        >
          <span className="flex items-center gap-3">
            <input type="radio" name="cb-mode" className="accent-[rgb(var(--c-brand))]" checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>
              <span className="block text-sm font-semibold">{o.label}</span>
              <span className="block text-xs text-muted">{o.hint}</span>
            </span>
          </span>
        </label>
      ))}
      <div className="flex flex-wrap gap-2 pt-2" aria-label="Preview">
        <Badge tone="ok" icon="check">On track</Badge>
        <Badge tone="warn" icon="alert">Due soon</Badge>
        <Badge tone="danger" icon="flag">Overdue</Badge>
        <Badge tone="info" icon="play">In progress</Badge>
      </div>
    </div>
  );
}
