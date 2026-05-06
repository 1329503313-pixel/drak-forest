import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AdminApp from "./admin/AdminApp";
import { initWeChatWebviewPaintPriming } from "@/utils/wechatWebview";
import "./index.css";

initWeChatWebviewPaintPriming();

const rootEl = document.getElementById("root")!;
const useAdmin = typeof window !== "undefined" && window.location.pathname.startsWith("/admin");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>{useAdmin ? <AdminApp /> : <App />}</React.StrictMode>
);
