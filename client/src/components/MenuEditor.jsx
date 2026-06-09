import { useState, useEffect } from 'react';
import { fetchMenu, saveMenu } from '../auth';

// Cook times are stored in seconds but edited in minutes, which is how kitchens think.
function toMinutes(seconds) {
  return String(Math.round((seconds / 60) * 10) / 10);
}

export default function MenuEditor({ onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchMenu()
      .then((menu) => {
        setRows(menu.length > 0 ? menu.map(fromMenuItem) : [emptyDish()]);
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  const updateDish = (i, patch) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addDish = () => setRows((prev) => [...prev, emptyDish()]);
  const removeDish = (i) =>
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const addMod = (i) =>
    updateDish(i, { modifiers: [...rows[i].modifiers, { name: '', deltaMinutes: '' }] });
  const updateMod = (i, j, patch) =>
    updateDish(i, { modifiers: rows[i].modifiers.map((m, idx) => (idx === j ? { ...m, ...patch } : m)) });
  const removeMod = (i, j) =>
    updateDish(i, { modifiers: rows[i].modifiers.filter((_, idx) => idx !== j) });

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const items = rows
      .map((r) => ({
        name: r.name.trim(),
        cookSeconds: Math.round(parseFloat(r.minutes) * 60),
        requiresModifier: r.requiresModifier,
        modifiers: r.modifiers
          .map((m) => ({ name: m.name.trim(), cookDeltaSeconds: Math.round(parseFloat(m.deltaMinutes) * 60) }))
          .filter((m) => m.name && Number.isFinite(m.cookDeltaSeconds)),
      }))
      .filter((it) => it.name && Number.isFinite(it.cookSeconds) && it.cookSeconds > 0);
    try {
      await saveMenu(items);
      setSaving(false);
      onClose();
    } catch (err) {
      setSaving(false);
      setError(err.message);
    }
  };

  return (
    <div className="menu-overlay">
      <div className="menu-editor">
        <h2 className="menu-title">Edit Menu</h2>
        <p className="menu-subtitle">Set each dish and its normal cook time. Modifiers adjust that time (use a negative value for faster).</p>

        {loading ? (
          <div className="menu-loading">Loading menu...</div>
        ) : (
          <>
            <div className="menu-list">
              {rows.map((dish, i) => (
                <div key={i} className="menu-dish">
                  <div className="menu-row">
                    <input
                      className="menu-name"
                      type="text"
                      value={dish.name}
                      onChange={(e) => updateDish(i, { name: e.target.value })}
                      placeholder="Dish name"
                    />
                    <input
                      className="menu-mins"
                      type="number"
                      value={dish.minutes}
                      onChange={(e) => updateDish(i, { minutes: e.target.value })}
                      placeholder="min"
                      min="0"
                      step="0.5"
                      inputMode="decimal"
                      aria-label="Cook minutes"
                    />
                    <button
                      className="menu-remove"
                      onClick={() => removeDish(i)}
                      disabled={rows.length === 1}
                      aria-label="Remove dish"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="menu-mods">
                    {dish.modifiers.length > 0 && (
                      <label className="menu-require">
                        <input
                          type="checkbox"
                          checked={dish.requiresModifier}
                          onChange={(e) => updateDish(i, { requiresModifier: e.target.checked })}
                        />
                        Require a modifier
                      </label>
                    )}
                    {dish.modifiers.map((mod, j) => (
                      <div key={j} className="menu-mod-row">
                        <input
                          className="menu-name"
                          type="text"
                          value={mod.name}
                          onChange={(e) => updateMod(i, j, { name: e.target.value })}
                          placeholder="Modifier (e.g. Well done)"
                        />
                        <input
                          className="menu-mins"
                          type="number"
                          value={mod.deltaMinutes}
                          onChange={(e) => updateMod(i, j, { deltaMinutes: e.target.value })}
                          placeholder="±min"
                          step="0.5"
                          inputMode="decimal"
                          aria-label="Modifier minutes"
                        />
                        <button className="menu-remove" onClick={() => removeMod(i, j)} aria-label="Remove modifier">
                          Remove
                        </button>
                      </div>
                    ))}
                    <button className="menu-add-mod" onClick={() => addMod(i)}>+ Add Modifier</button>
                  </div>
                </div>
              ))}
            </div>

            <button className="menu-add" onClick={addDish}>+ Add Dish</button>
            {error && <p className="menu-error">{error}</p>}

            <div className="menu-actions">
              <button className="menu-cancel" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="menu-save" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Menu'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function emptyDish() {
  return { name: '', minutes: '', requiresModifier: false, modifiers: [] };
}

function fromMenuItem(m) {
  return {
    name: m.name,
    minutes: toMinutes(m.cookSeconds),
    requiresModifier: !!m.requiresModifier,
    modifiers: (m.modifiers || []).map((mod) => ({ name: mod.name, deltaMinutes: toMinutes(mod.cookDeltaSeconds) })),
  };
}
