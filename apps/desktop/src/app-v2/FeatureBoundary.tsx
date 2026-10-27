import { Component, type ReactNode } from "react";

/** Keep project controls and the original session mounted if a lazy feature cannot render. */
export class FeatureBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
