
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const COMBO_PREFIX = "__combo__:";

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [combos, setCombos] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/proxy-combos", { cache: "no-store" }).then((r) => r.ok ? r.json() : { combos: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, comboData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      setCombos(comboData.combos || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      if (override.comboId) setProxyPoolId(`${COMBO_PREFIX}${override.comboId}`);
      else setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const handleChange = async (newValue) => {
    setProxyPoolId(newValue);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      // Clear both fields first
      delete override.proxyPoolId;
      delete override.comboId;
      if (newValue === NONE_PROXY_POOL_VALUE) {
        // nothing to set
      } else if (newValue.startsWith(COMBO_PREFIX)) {
        override.comboId = newValue.replace(COMBO_PREFIX, "");
      } else {
        override.proxyPoolId = newValue;
      }
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxyPoolId error:", e);
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
    ...(combos.length > 0 ? [{ label: "── Combos ──", value: "__divider_combo__", disabled: true }] : []),
    ...combos.map((c) => ({ value: `${COMBO_PREFIX}${c.id}`, label: `🔄 ${c.name}` })),
    ...(proxyPools.length > 0 && combos.length > 0 ? [{ label: "── Pools ──", value: "__divider_pool__", disabled: true }] : []),
    ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
  ];

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route through a proxy pool or combo for round-robin rotation.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>
      <Select
        label="Proxy Pool / Combo"
        value={proxyPoolId}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        options={options}
      />
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
