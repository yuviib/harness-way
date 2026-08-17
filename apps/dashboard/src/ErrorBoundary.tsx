// Added after seeing the actual failure mode in practice, not speculatively:
// LiveFanoutView's WebSocket-fragment bug threw during a passive effect
// with no boundary anywhere in the tree, which unmounted the entire page
// to a blank screen -- a single bad connection attempt should degrade to
// an error message in that one view, not take down the dashboard.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Dashboard view crashed:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="rounded-card border px-4 py-3.5" style={{ borderColor: "var(--color-status-critical)" }}>
          <p className="text-sm text-ink-2">This view crashed: {this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-2.5 rounded-control border border-rule px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-rule-2"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
