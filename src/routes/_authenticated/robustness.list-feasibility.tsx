import { createFileRoute } from "@tanstack/react-router";
import { ListFeasibilityPage } from "./-list-feasibility-page";

export const Route = createFileRoute("/_authenticated/robustness/list-feasibility")({
  head: () => ({ meta: [{ title: "List feasibility — Salisbury Anaesthetics Rota" }] }),
  component: ListFeasibilityPage,
});
