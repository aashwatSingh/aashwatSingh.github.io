"""Page-side helpers for the questions the profile cannot answer.

Three small scripts, shared by every adapter:

* PROBE_JS    is a field marked required in the DOM, and does its own text call it optional?
* ASSIST_JS   highlight one field, and track whether keyboard focus is inside each watched field
              (so the runner can tell "typed something and clicked away" from "still typing").
* FLAGGED_JS  after a Submit / Next click: which fields carry a validation error.

The adapters keep extracting fields their own way; these run on the selectors they produce. A
selector is either the control itself (Greenhouse) or the question's wrapper (Ashby, Lever,
Workday), so each script first resolves the wrapper with wrapOf().
"""
from __future__ import annotations

import re

HIGHLIGHT_COLOR = "#a855f7"
BADGE_TEXT = "Fill & click outside to auto-continue"
BLUR_SETTLE_MS = 800              # focus must stay out of the field (or a choice stay put) this long

# "Optional" in a label, placeholder or helper text. "Optional Practical Training" (OPT) is a
# visa status, not a statement about the question.
OPTIONAL_TEXT = re.compile(r"\boptional\b(?!\s+practical)", re.I)

_WRAP_JS = r"""
  const WRAP = '.select-shell, fieldset, .application-question, .application-additional, ' +
    '.ashby-application-form-field-entry, [class*="_fieldEntry_"], [data-automation-id^="formField-"], ' +
    '.file-upload, .text-input-wrapper, .input-wrapper, .field-wrapper, .field, .form-group';
  const isControl = el => el.matches('input, textarea, select, button');
  const wrapOf = sel => {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { return null; }
    if (!el) return null;
    if (!isControl(el)) return el;
    // A control: the nearest ancestor that also holds its own label (not a whole section's fieldset).
    const own = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    if (own) {
      let node = el.parentElement;
      for (let k = 0; k < 6 && node && node !== document.body && node.tagName !== 'FORM'; k++) {
        if (node.contains(own) || (node.tagName !== 'FIELDSET' && node.matches(WRAP))) return node;
        node = node.parentElement;
      }
    }
    return el.closest(WRAP) || el.parentElement || el;
  };
  const shown = el => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
  const text = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
"""

# [selectors] -> [{required, optional} | null]
PROBE_JS = "(sels) => {" + _WRAP_JS + r"""
  const OPTIONAL = /\boptional\b(?!\s+practical)/i;
  const STAR = /[*✱]\s*$|^\s*[*✱]/;
  return sels.map(sel => {
    const wrap = wrapOf(sel);
    if (!wrap) return null;
    const el = document.querySelector(sel);
    const ctls = isControl(el) ? [el]
      : [...wrap.querySelectorAll('input:not([type=hidden]), textarea, select, [role=combobox], [role=radiogroup], [role=listbox]')];
    const picks = ctls.filter(c => c.type === 'radio' || c.type === 'checkbox');
    const optionLabel = l => picks.length > 1 && (!!l.querySelector('input[type=radio], input[type=checkbox]') ||
      picks.some(p => p.id && l.htmlFor === p.id));
    const labs = [...wrap.querySelectorAll('legend, label')].filter(l => !optionLabel(l));
    if (isControl(el) && el.id) {
      const own = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (own && !labs.includes(own)) labs.push(own);
    }
    const star = l => STAR.test(text(l)) ||
      !!l.querySelector('abbr[title*="equired"], .asterisk, [aria-label*="equired"]') ||
      ['::before', '::after'].some(p => /[*✱]/.test(getComputedStyle(l, p).content || ''));
    const required =
      ctls.some(c => c.required || c.getAttribute('aria-required') === 'true') ||
      wrap.getAttribute('aria-required') === 'true' ||
      wrap.matches('.required, [data-required="true"]') ||
      !!wrap.querySelector('.required, [data-required="true"]') ||
      labs.some(l => /(^|[\s_-])required([\s_-]|$)/.test(String(l.className)) || star(l));
    const helper = [...wrap.querySelectorAll('[id$="-description"], [class*="descri"], .helper-text, small, [class*="hint"]')]
      .filter(h => !/error/i.test(String(h.className) + h.id));
    const said = [...labs.map(text), ...ctls.map(c => c.getAttribute('placeholder') || ''), ...helper.map(text)];
    return {required, optional: said.some(s => OPTIONAL.test(s))};
  });
}"""

# Installs window.__iaAssist once per document.
ASSIST_JS = "(() => { if (window.__iaAssist) return;" + _WRAP_JS + r"""
  const A = window.__iaAssist = {items: [], current: -1, badge: null, saved: null};
  const at = node => A.items.findIndex(it => it.wrap && node instanceof Node && it.wrap.contains(node));
  const enter = e => { const i = at(e.target); if (i >= 0) { A.items[i].inside = true; A.items[i].touched = true; } };
  const leave = e => { const i = at(e.target); if (i >= 0) { A.items[i].inside = false; A.items[i].leftAt = performance.now(); } };
  document.addEventListener('focusin', enter, true);
  document.addEventListener('focusout', leave, true);
  document.addEventListener('blur', leave, true);

  A.start = sels => {
    A.clear();
    A.items = sels.map(sel => {
      const wrap = wrapOf(sel);
      const inside = !!(wrap && wrap.contains(document.activeElement) && document.activeElement !== document.body);
      return {sel, wrap, inside, touched: inside, leftAt: performance.now()};
    });
    return A.items.length;
  };
  A.state = () => {
    const now = performance.now();
    if (A.badge && A.current >= 0) A.place();
    return A.items.map(it => {
      if (!it.wrap || !it.wrap.isConnected) it.wrap = wrapOf(it.sel);          // the page re-rendered the field
      const w = it.wrap;
      if (!w) return {missing: true, awayMs: 1e9, open: false, files: 0, touched: false};
      const files = [...w.querySelectorAll('input[type=file]')].reduce((n, f) => n + (f.files ? f.files.length : 0), 0);
      return {missing: false, awayMs: it.inside ? 0 : now - it.leftAt, touched: !!it.touched, files,
              open: !!w.querySelector('[aria-expanded="true"]') || w.getAttribute('aria-expanded') === 'true'};
    });
  };
  A.place = () => {
    const w = A.items[A.current] && A.items[A.current].wrap;
    if (!w || !A.badge) return;
    const r = w.getBoundingClientRect();
    A.badge.style.top = Math.max(0, r.top + window.scrollY - 30) + 'px';
    A.badge.style.left = Math.max(0, r.left + window.scrollX) + 'px';
  };
  A.clear = () => {
    if (A.saved) {
      const {el, outline, outlineOffset, boxShadow, borderRadius} = A.saved;
      Object.assign(el.style, {outline, outlineOffset, boxShadow, borderRadius});
      el.removeAttribute('data-ia-assist');
    }
    if (A.badge) A.badge.remove();
    A.saved = A.badge = null; A.current = -1;
  };
  A.highlight = (i, label, color) => {
    A.clear();
    const it = A.items[i];
    if (!it) return false;
    if (!it.wrap || !it.wrap.isConnected) it.wrap = wrapOf(it.sel);
    const w = it.wrap;
    if (!w) return false;
    A.saved = {el: w, outline: w.style.outline, outlineOffset: w.style.outlineOffset,
               boxShadow: w.style.boxShadow, borderRadius: w.style.borderRadius};
    Object.assign(w.style, {outline: '3px solid ' + color, outlineOffset: '4px', borderRadius: '6px',
                            boxShadow: '0 0 0 7px rgba(168,85,247,.16), 0 0 22px rgba(168,85,247,.45)'});
    w.setAttribute('data-ia-assist', '1');
    const b = A.badge = document.createElement('div');
    b.id = 'ia-assist-badge'; b.textContent = label; b.setAttribute('role', 'status');
    Object.assign(b.style, {position: 'absolute', zIndex: 2147483647, background: color, color: '#fff',
      font: '600 12px/1.2 system-ui, sans-serif', padding: '4px 9px', borderRadius: '6px', pointerEvents: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,.25)', whiteSpace: 'nowrap'});
    document.body.appendChild(b);
    A.current = i;
    w.scrollIntoView({block: 'center', inline: 'nearest'});
    A.place();
    return true;
  };
})()"""

# [selectors] -> ["error text" | "" ...]: the validation error showing on each field, if any.
FLAGGED_JS = ("(arg) => { const sels = Array.isArray(arg) ? arg : arg.sels;"
              " const textOnly = !Array.isArray(arg) && !!arg.textOnly;") + _WRAP_JS + r"""
  const ERR = '[id$="-error"], .helper-text--error, .error-message, .error, .invalid-feedback, ' +
    '[class*="_error_"], [class*="_errors_"], [class*="error-text"], [class*="errorText"], [role="alert"], ' +
    '[data-automation-id="inputAlert"], [data-automation-id="errorMessage"]';
  return sels.map(sel => {
    const wrap = wrapOf(sel);
    if (!wrap) return '';
    const el = document.querySelector(sel);
    const found = [...wrap.querySelectorAll(ERR)].filter(e => shown(e) && text(e));
    if (el && el.id) {
      const own = document.getElementById(el.id + '-error');
      if (own && shown(own) && text(own)) found.push(own);
    }
    if (found.length) return text(found[0]).slice(0, 160);
    if (textOnly) return '';                // before Submit: only messages the page actually shows
    const ctls = isControl(el) ? [el] : [...wrap.querySelectorAll('input:not([type=hidden]), textarea, select, [role=combobox]')];
    if (ctls.some(c => c.getAttribute('aria-invalid') === 'true')) return 'invalid';
    if (ctls.some(c => c.willValidate && c.validity && !c.validity.valid)) return 'invalid';
    return '';
  });
}"""


def says_optional(*texts: str) -> bool:
    """A label / placeholder / helper text that calls its own question optional."""
    return any(OPTIONAL_TEXT.search(t or "") for t in texts)


def needs_blur(kind: str, widget: str) -> bool:
    """Typed and multi-pick fields are finished when focus leaves them; a single committed choice
    (radio, one checkbox, a native or ARIA dropdown, an upload) is finished as soon as it settles."""
    if kind in ("radio", "boolean", "checkbox", "file"):
        return False
    if kind == "select" and widget in ("select", "dropdown", "yesno", "boxes"):
        return False
    return True
