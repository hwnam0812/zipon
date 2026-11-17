import type { RouteObject } from "react-router";
import App from "./App";
import Admin from "./pages/Admin";
import Home from "./pages/Home";
import History from "./pages/History";
import Settings from "./pages/Settings";
import Devices from "./pages/Devices";
import Monitor from "./pages/Monitor";
import { Navigate } from "react-router";

// Every page of the app is listed here, and only here. main.tsx builds the router from this
// array and exposes it as window.__baze.routes so the BAZE preview can list the pages.
// App (src/App.tsx) is the shell around every page; it renders the current page in <Outlet />.
// A page only the owner opens carries handle: { owner: true }: the preview's page list groups it
// apart from the visitor pages. The owner layer is in src/owner/ (src/owner/OWNER.md).
export const routes: RouteObject[] = [
  {
    element: <App />,
    children: [
      { path: "/admin", element: <Admin />, handle: { owner: true } },
      { index: true, element: <Home /> },
      { path: "/history", element: <History /> },
      { path: "/settings", element: <Settings /> },
      { path: "/devices", element: <Devices /> },
      { path: "/monitor", element: <Monitor /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];
