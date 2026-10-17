// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { EmptyState, LinkButton } from "../ui";

export function NotFoundPage() {
  return (
    <div className="page">
      <EmptyState title="Page not found" actions={<LinkButton to="/" variant="primary">Go to Ask</LinkButton>}>
        This address doesn&apos;t match a console page.
      </EmptyState>
    </div>
  );
}
