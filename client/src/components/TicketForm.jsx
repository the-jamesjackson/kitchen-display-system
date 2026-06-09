import { useState } from 'react';

const emptyItem = () => ({ name: '', quantity: 1, mods: '', custom: false, modifiers: [] });

// "+3m" / "-2m" / "" for a modifier's cook-time delta in seconds.
function deltaLabel(seconds) {
  const m = Math.round((seconds / 60) * 10) / 10;
  if (m === 0) return '';
  return `${m > 0 ? '+' : ''}${m}m`;
}

export default function TicketForm({ onSubmit, menu = [] }) {
  const [table, setTable] = useState('');
  const [items, setItems] = useState([emptyItem()]);
  const [formError, setFormError] = useState('');

  // When a menu is defined, items are picked from it (keeps dish names canonical).
  const usingMenu = menu.length > 0;

  const addItem = () => setItems((prev) => [...prev, emptyItem()]);

  const removeItem = (index) => {
    if (items.length === 1) return;
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const updateItem = (index, patch) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const handleSelect = (index, value) => {
    // Changing the dish resets its modifiers, since modifiers belong to a dish.
    if (value === '__custom__') updateItem(index, { custom: true, name: '', modifiers: [] });
    else updateItem(index, { custom: false, name: value, modifiers: [] });
  };

  const toggleModifier = (index, modName) => {
    const current = items[index].modifiers;
    const next = current.includes(modName)
      ? current.filter((m) => m !== modName)
      : [...current, modName];
    updateItem(index, { modifiers: next });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const validItems = items.filter((i) => i.name.trim());
    if (!table || validItems.length === 0) return;

    // Block dishes that require a modifier but have none selected.
    const missing = validItems.filter((i) => {
      const menuItem = !i.custom ? menu.find((m) => m.name === i.name) : null;
      return menuItem && menuItem.requiresModifier && menuItem.modifiers.length > 0 && i.modifiers.length === 0;
    });
    if (missing.length > 0) {
      setFormError(`Select a modifier for: ${[...new Set(missing.map((i) => i.name))].join(', ')}`);
      return;
    }

    setFormError('');
    onSubmit(
      table,
      validItems.map(({ name, quantity, mods, modifiers }) => ({ name, quantity, mods, modifiers }))
    );
    setTable('');
    setItems([emptyItem()]);
  };

  return (
    <form className="ticket-form" onSubmit={handleSubmit}>
      <h2>New Ticket</h2>

      <div className="form-group">
        <label htmlFor="table-input">Table</label>
        <input
          id="table-input"
          type="number"
          value={table}
          onChange={(e) => setTable(e.target.value)}
          placeholder="1"
          min="1"
          required
          className="table-input"
          inputMode="numeric"
        />
      </div>

      <div className="form-group">
        <span className="items-label">Items</span>
        {items.map((item, index) => {
          const menuItem = usingMenu && !item.custom ? menu.find((m) => m.name === item.name) : null;
          return (
            <div key={index} className="item-row">
              <input
                type="number"
                value={item.quantity}
                onChange={(e) => updateItem(index, { quantity: parseInt(e.target.value, 10) || 1 })}
                min="1"
                className="qty-input"
                inputMode="numeric"
                aria-label="Quantity"
              />
              <div className="item-inputs">
                {usingMenu ? (
                  <>
                    <select
                      className="name-input name-select"
                      value={item.custom ? '__custom__' : item.name}
                      onChange={(e) => handleSelect(index, e.target.value)}
                      aria-label="Item"
                    >
                      <option value="">Select item...</option>
                      {menu.map((m) => (
                        <option key={m.name} value={m.name}>{m.name}</option>
                      ))}
                      <option value="__custom__">Custom item...</option>
                    </select>
                    {item.custom && (
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => updateItem(index, { name: e.target.value })}
                        placeholder="Custom item name"
                        className="name-input"
                        aria-label="Custom item name"
                      />
                    )}
                    {menuItem && menuItem.modifiers.length > 0 && (
                      <div className="mod-chips">
                        {menuItem.modifiers.map((mod) => (
                          <button
                            type="button"
                            key={mod.name}
                            className={`mod-chip${item.modifiers.includes(mod.name) ? ' active' : ''}`}
                            onClick={() => toggleModifier(index, mod.name)}
                          >
                            {mod.name}
                            {deltaLabel(mod.cookDeltaSeconds) && (
                              <span className="mod-chip-delta">{deltaLabel(mod.cookDeltaSeconds)}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    value={item.name}
                    onChange={(e) => updateItem(index, { name: e.target.value })}
                    placeholder="Item name"
                    className="name-input"
                    aria-label="Item name"
                  />
                )}
                <input
                  type="text"
                  value={item.mods}
                  onChange={(e) => updateItem(index, { mods: e.target.value })}
                  placeholder="Notes"
                  className="mods-input"
                  aria-label="Notes"
                />
              </div>
              <button
                type="button"
                onClick={() => removeItem(index)}
                className="remove-btn"
                disabled={items.length === 1}
                aria-label="Remove item"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <button type="button" onClick={addItem} className="add-item-btn">
        + Add Item
      </button>

      {formError && <p className="form-error">{formError}</p>}

      <button type="submit" className="submit-btn">
        Fire Ticket
      </button>
    </form>
  );
}
