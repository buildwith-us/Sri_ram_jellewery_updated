import React from "react";
import { Outlet } from "react-router-dom";
import { LoginGateProvider } from "../context/LoginGateContext";
import useResumePendingAction from "../hooks/useResumePendingAction";

/**
 * The one element above every page — main site, product pages and dashboard.
 *
 * The sign-in gate lives here, once, rather than in each layout: the modal, its
 * once-per-session timer and the pending action then survive moving between
 * the three route trees (each used to mount its own copy, which reset the
 * timer and remounted the prompt on every cross-layout navigation).
 */
const ResumePendingAction = () => {
  useResumePendingAction();
  return null;
};

const AppShell = () => (
  <LoginGateProvider>
    <ResumePendingAction />
    <Outlet />
  </LoginGateProvider>
);

export default AppShell;
