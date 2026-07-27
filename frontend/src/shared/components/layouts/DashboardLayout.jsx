
import { useState, useEffect } from "react";
import { useLocation, Outlet, useNavigate } from 'react-router-dom';
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";
import Button from "../Button";

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: "warning",
    };
  }
  return {
    wrapper: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    icon: "info",
  };
}

export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showPasswordWarning, setShowPasswordWarning] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // Check default password on every route change
  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        // If password matches default (or doesn't exist), enforce warning
        if (data.isDefaultPassword && pathname !== "/dashboard/profile") {
          setShowPasswordWarning(true);
        } else {
          setShowPasswordWarning(false); // hide if fixed or on profile page
        }
      })
      .catch(() => {});
  }, [pathname]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg">
      <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] leading-5">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Desktop */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Sidebar - Mobile */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <main className="flex flex-col flex-1 h-full min-w-0 relative transition-colors duration-300 isolate">
        {/* Faint grid background */}
        <div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />
        <Header key={pathname} onMenuClick={() => setSidebarOpen(true)} />
        <div className={`flex-1 overflow-y-auto custom-scrollbar ${pathname === "/dashboard/basic-chat" || pathname === "/dashboard/docs" ? "" : "p-6 lg:p-10"} ${pathname === "/dashboard/basic-chat" || pathname === "/dashboard/docs" ? "flex flex-col overflow-hidden" : ""}`}>
          <div className={`${pathname === "/dashboard/basic-chat" || pathname === "/dashboard/docs" ? "flex-1 w-full h-full flex flex-col" : "max-w-7xl mx-auto"}`}><Outlet /></div>
        </div>
      </main>

      {/* Password warning modal */}
      {showPasswordWarning && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl bg-surface border border-border-subtle p-6 shadow-2xl flex flex-col gap-4 text-text-main animate-in fade-in zoom-in duration-200">
            <div className="flex items-center gap-3">
              <div className="size-11 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-[24px]">warning</span>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Ganti Password Default Anda!</h3>
                <p className="text-xs text-text-muted mt-0.5">Password admin saat ini sangat tidak aman.</p>
              </div>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              FSRouter mendeteksi bahwa Anda masih menggunakan password default "123456" atau tidak memiliki password pengaman. Harap segera menggantinya di halaman profil untuk melindungi akses dashboard Anda.
            </p>
            <div className="flex gap-2 mt-2">
              <Button variant="secondary" size="sm" onClick={() => setShowPasswordWarning(false)}>
                Tutup Sementara
              </Button>
              <Button variant="primary" size="sm" className="flex-1" onClick={() => { setShowPasswordWarning(false); navigate("/dashboard/profile"); }}>
                Ganti Password Sekarang
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
