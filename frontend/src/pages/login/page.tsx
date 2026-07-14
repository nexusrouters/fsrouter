import React, { useState, useEffect } from "react";
import { useNavigate } from 'react-router-dom';
import { Testimonial } from "@/components/ui/sign-in";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [resetHint, setResetHint] = useState("");
  const [retryAfter, setRetryAfter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [authMode, setAuthMode] = useState("password");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  useEffect(() => {
    async function checkAuth() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
      try {
        const res = await fetch(`${baseUrl}/api/auth/status`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          const params = new URLSearchParams(window.location.search);
          const isForced = params.get("force") === "true" || params.get("force") === "1";
          if (data.requireLogin === false && !isForced) {
            localStorage.setItem("9r_authed", "1");
            navigate("/dashboard");
            navigate(0);
            return;
          }
          setHasPassword(!!data.hasPassword);
          setAuthMode(data.authMode || "password");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
        } else {
          setHasPassword(true);
        }
      } catch {
        clearTimeout(timeoutId);
        setHasPassword(true);
      }
    }
    checkAuth();
  }, [navigate]);

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResetHint("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        localStorage.setItem("9r_authed", "1");
        navigate("/dashboard");
        navigate(0);
      } else {
        const data = await res.json();
        setError(data.error || "Invalid password");
        if (data.resetHint) setResetHint(data.resetHint);
        if (data.retryAfter) setRetryAfter(Number(data.retryAfter));
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOidcLogin = () => { window.location.href = "/api/auth/oidc/start"; };
  const oidcAvailable = oidcConfigured && ["oidc", "both"].includes(authMode);
  const passwordAvailable = authMode !== "oidc" || !oidcConfigured;
  const showOidcInfoMessage = (authMode === "oidc" && !oidcConfigured) || (authMode === "both" && !oidcConfigured);
  const showBothInfoMessage = authMode === "both" && oidcConfigured;

  if (hasPassword === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-violet-200/30 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-blue-200/30 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Card */}
        <div className="bg-white rounded-2xl shadow-lg shadow-slate-200/50 border border-slate-200/60 p-8">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-blue-500 mb-4 shadow-lg shadow-violet-500/25">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">FSRouter</h1>
            <p className="text-sm text-slate-500 mt-1">
              {authMode === "oidc" && oidcConfigured
                ? "Sign in with your OIDC provider"
                : "Enter your password to continue"}
            </p>
          </div>

          {/* OIDC Info */}
          {showOidcInfoMessage && (
            <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
              OIDC not configured yet. Password login is available.
            </div>
          )}
          {showBothInfoMessage && (
            <div className="mb-4 p-3 rounded-lg bg-violet-50 border border-violet-200 text-xs text-violet-700 text-center">
              Password and OIDC login are both enabled.
            </div>
          )}

          {/* Password Form */}
          {passwordAvailable && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1.5">Password</label>
                <div className="relative">
                  <input
                    name="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus
                    className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm p-3 pr-10 rounded-xl focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 placeholder-slate-400 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-3 flex items-center text-slate-400 hover:text-slate-600"
                  >
                    {showPassword ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878l4.242 4.242M21 21l-3.122-3.122" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    )}
                  </button>
                </div>
                {error && <p className="text-xs text-red-500 mt-1.5">{error}</p>}
                {retryAfter > 0 && <p className="text-xs text-amber-600 mt-1.5">Locked. Retry in {retryAfter}s.</p>}
              </div>

              <button
                type="submit"
                disabled={loading || retryAfter > 0}
                className="w-full bg-gradient-to-r from-violet-500 to-blue-500 hover:from-violet-600 hover:to-blue-600 text-white font-medium text-sm py-3 rounded-xl transition-all shadow-lg shadow-violet-500/25 disabled:opacity-50 cursor-pointer"
              >
                {loading ? "Logging in..." : retryAfter > 0 ? `Wait ${retryAfter}s` : "Login"}
              </button>

              <p className="text-center text-xs text-slate-400">
                Default password is <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono">123456</code>
              </p>
            </form>
          )}

          {/* OIDC Button */}
          {oidcAvailable && (
            <>
              {passwordAvailable && (
                <div className="relative flex items-center justify-center py-4">
                  <span className="w-full border-t border-slate-200" />
                  <span className="px-3 text-xs text-slate-400 bg-white absolute">or</span>
                </div>
              )}
              <button
                onClick={handleOidcLogin}
                type="button"
                className="w-full flex items-center justify-center gap-2 border border-slate-200 rounded-xl py-3 hover:bg-slate-50 transition-colors text-slate-600 text-sm cursor-pointer"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>
                {oidcLoginLabel}
              </button>
            </>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-slate-400 mt-6">
          Powered by FSRouter
        </p>
      </div>
    </div>
  );
}
