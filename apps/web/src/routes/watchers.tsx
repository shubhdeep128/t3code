import { createFileRoute, redirect } from "@tanstack/react-router";

import { WatchersPage } from "../components/watchers/WatchersPage";

export const Route = createFileRoute("/watchers")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WatchersPage,
});
