import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Suspense, lazy, useState, useEffect } from "react";
import { DashboardLayout } from "@/shared/components/layouts";

// Lazy-loaded pages (code splitting — loads each page only when needed)
const Landing         = lazy(() => import("./pages/landing/page"));
const Login           = lazy(() => import("./pages/login/page"));
const Callback        = lazy(() => import("./pages/callback/page"));
const Dashboard       = lazy(() => import("./pages/page"));
const Providers       = lazy(() => import("./pages/providers/page"));
const ProviderDetail  = lazy(() => import("./pages/providers/[id]/page"));
const ProvidersNew    = lazy(() => import("./pages/providers/new/page"));
const Usage           = lazy(() => import("./pages/usage/page"));
const Quota           = lazy(() => import("./pages/quota/page"));
const ProxyPools      = lazy(() => import("./pages/proxy-pools/page"));
const Combos          = lazy(() => import("./pages/combos/page"));
const Endpoint        = lazy(() => import("./pages/endpoint/page"));
const TokenSaver      = lazy(() => import("./pages/token-saver/page"));
const Mcp             = lazy(() => import("./pages/mcp/page"));
const Translator      = lazy(() => import("./pages/translator/page"));
const CliTools        = lazy(() => import("./pages/cli-tools/page"));
const CliToolDetail   = lazy(() => import("./pages/cli-tools/[toolId]/page"));
const Automation      = lazy(() => import("./pages/automation/page"));
const BasicChat       = lazy(() => import("./pages/basic-chat/page"));
const Mitm            = lazy(() => import("./pages/mitm/page"));
const Profile         = lazy(() => import("./pages/profile/page"));
const Docs            = lazy(() => import("./pages/docs/page"));
const Skills          = lazy(() => import("./pages/skills/page"));
const ConsoleLog      = lazy(() => import("./pages/console-log/page"));
const BackupRestore   = lazy(() => import("./pages/backup-restore/page"));
const MediaProviders  = lazy(() => import("./pages/media-providers/web/page"));
const MediaProviderKind  = lazy(() => import("./pages/media-providers/[kind]/page"));
const MediaProviderKindId = lazy(() => import("./pages/media-providers/[kind]/[id]/page"));
const MediaProviderComboDetail = lazy(() => import("./pages/media-providers/combo/[id]/page"));
const WeavyPool          = lazy(() => import("./pages/providers/weavy/pool/page"));
const FSMailTutorial     = lazy(() => import("./pages/automation/fsmail-tutorial/page"));
const SearchPage         = lazy(() => import("./pages/search/page"));
const ModerationsPage    = lazy(() => import("./pages/moderations/page"));
const RerankPage         = lazy(() => import("./pages/rerank/page"));
const OcrPage            = lazy(() => import("./pages/ocr/page"));
const WebFetchPage       = lazy(() => import("./pages/webfetch/page"));
const AudioPage          = lazy(() => import("./pages/audio/page"));
const UpdatePage         = lazy(() => import("./pages/update/page"));

// Auth guard — verifies session with backend on every mount
function RequireAuth({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "ok" | "denied">("checking");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    fetch("/api/auth/status", { signal: controller.signal, credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        if (data.requireLogin === false || data.isLoggedIn === true) {
          localStorage.setItem("9r_authed", "1");
          setStatus("ok");
        } else {
          localStorage.removeItem("9r_authed");
          setStatus("denied");
        }
      })
      .catch(() => {
        clearTimeout(timeoutId);
        if (!cancelled) setStatus("denied");
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (status === "checking") return <LoadingFallback />;
  if (status === "denied") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function LoadingFallback() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <span>Loading...</span>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Public */}
          <Route path="/"       element={<Navigate to="/login" replace />} />
          <Route path="/login"  element={<Login />} />
          <Route path="/callback" element={<Callback />} />

          {/* Protected dashboard */}
          <Route path="/dashboard" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="providers"       element={<Providers />} />
            <Route path="providers/new"   element={<ProvidersNew />} />
            <Route path="providers/weavy/pool" element={<WeavyPool />} />
            <Route path="providers/:id"   element={<ProviderDetail />} />
            <Route path="usage"           element={<Usage />} />
            <Route path="quota"           element={<Quota />} />
            {/* Pricing settings page omitted in v2 currently */}
            <Route path="proxy-pools"     element={<ProxyPools />} />
            <Route path="combos"          element={<Combos />} />
            <Route path="endpoint"        element={<Endpoint />} />
            <Route path="token-saver"     element={<TokenSaver />} />
            <Route path="mcp"             element={<Mcp />} />
            <Route path="translator"      element={<Translator />} />
            <Route path="cli-tools"       element={<CliTools />} />
            <Route path="cli-tools/:toolId" element={<CliToolDetail />} />
            <Route path="automation"      element={<Automation />} />
            <Route path="automation/fsmail-tutorial" element={<FSMailTutorial />} />
            <Route path="basic-chat"      element={<BasicChat />} />
            <Route path="mitm"            element={<Mitm />} />
            <Route path="profile"         element={<Profile />} />
            <Route path="docs"            element={<Docs />} />
            <Route path="skills"          element={<Skills />} />
            <Route path="console-log"     element={<ConsoleLog />} />
            <Route path="media-providers/web" element={<MediaProviders />} />
            <Route path="media-providers/:kind" element={<MediaProviderKind />} />
            <Route path="media-providers/:kind/:id" element={<MediaProviderKindId />} />
            <Route path="media-providers/combo/:id" element={<MediaProviderComboDetail />} />
            <Route path="search"           element={<SearchPage />} />
            <Route path="moderations"      element={<ModerationsPage />} />
            <Route path="rerank"           element={<RerankPage />} />
            <Route path="ocr"              element={<OcrPage />} />
            <Route path="webfetch"         element={<WebFetchPage />} />
            <Route path="audio"            element={<AudioPage />} />
            <Route path="update"           element={<UpdatePage />} />
            <Route path="backup-restore"   element={<BackupRestore />} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
