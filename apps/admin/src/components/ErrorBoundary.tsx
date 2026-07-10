import { Component, type ErrorInfo, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { withTranslation, type WithTranslation } from "react-i18next";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

class ErrorBoundaryBase extends Component<Props & WithTranslation, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Admin error boundary caught:", error, info.componentStack);
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack } },
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { t } = this.props;

    return (
      <div className="error-boundary">
        <div className="error-boundary__card">
          <h1>{t("errorBoundary.title")}</h1>
          <p>{t("errorBoundary.body")}</p>
          <p className="error-boundary__message">{this.state.error.message}</p>
          <div className="error-boundary__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              {t("errorBoundary.reload")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => this.setState({ error: null })}
            >
              {t("errorBoundary.tryAgain")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryBase);
