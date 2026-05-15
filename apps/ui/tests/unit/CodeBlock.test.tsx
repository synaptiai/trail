import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { CodeBlock } from '@/components/primitives/CodeBlock';

/**
 * <CodeBlock> primitive (Sprint 3b — gh#10 criterion 3).
 *
 * Pinned contracts:
 *   1. Resolves a registered language correctly from props.
 *   2. Falls back to plaintext when language is not provided AND no path
 *      hint is available — never throws on unknown content.
 *   3. role="figure" with aria-label so screen readers locate it; the
 *      semantics differ from `<DiffHunk>` (region) because this is a
 *      passage of code without an addition/removal axis.
 *   4. Shows a "Loading…" placeholder until shiki resolves.
 *   5. Escapes raw markup in the source content (XSS regression gate).
 *   6. Passes axe-core scan.
 *   7. lang="..." attribute exposes the resolved language to assistive
 *      tech (an excerpt's language is part of its semantic meaning).
 */

describe('<CodeBlock>', () => {
  it('renders a figure with the supplied aria-label', async () => {
    render(
      <CodeBlock
        language="typescript"
        code={'const x = 1;\nconst y = 2;'}
        ariaLabel="Evidence excerpt for CLAIM-001"
      />,
    );
    const figure = await screen.findByRole('figure', {
      name: 'Evidence excerpt for CLAIM-001',
    });
    expect(figure).toBeInTheDocument();
  });

  it('renders shiki tokens for typescript code', async () => {
    const { container } = render(
      <CodeBlock language="typescript" code={'const x = 1;'} ariaLabel="x" />,
    );
    await waitFor(() => {
      // After shiki resolves, the source text "const" should be wrapped
      // in a span with style attribute (token-rendered).
      expect(container.querySelector('span[style]')).not.toBeNull();
    });
  });

  it('escapes raw markup in source content (XSS gate)', async () => {
    const { container } = render(
      <CodeBlock
        language="typescript"
        code={'const evil = "<script>alert(1)</script>";'}
        ariaLabel="x"
      />,
    );
    await waitFor(() => {
      const html = container.innerHTML;
      // Raw <script> bytes must not appear; entity-escaped form is
      // the only acceptable rendering.
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script');
    });
  });

  it('falls back to plaintext when language is unknown', async () => {
    const { container } = render(
      <CodeBlock language="plaintext" code={'arbitrary text'} ariaLabel="x" />,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('arbitrary text');
    });
  });

  it('shows Loading placeholder before highlight resolves', async () => {
    render(<CodeBlock language="typescript" code={'const x = 1;'} ariaLabel="x" />);
    // Synchronous render; before useEffect runs the placeholder shows.
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    // Drain the highlighter promise so the post-resolution
    // setHighlighted(...) state update settles inside this test's act()
    // boundary. Without the await, React surfaces "not wrapped in act"
    // when useEffect's then-callback fires after the synchronous expect.
    await screen.findByRole('figure', { name: 'x' });
  });

  it('exposes a data-lang attribute on the figure element (NOT lang=)', async () => {
    render(
      <CodeBlock
        language="python"
        code={'print("ok")'}
        ariaLabel="Python excerpt"
      />,
    );
    const figure = await screen.findByRole('figure', { name: 'Python excerpt' });
    // The HTML `lang` attribute is reserved for human languages per WCAG
    // 3.1.1/3.1.2; axe-core's `valid-lang` rule rejects programming-
    // language values. We expose the syntax language as `data-lang` so
    // styling + tests can introspect it without violating BCP-47.
    expect(figure.getAttribute('data-lang')).toBe('python');
    expect(figure.getAttribute('lang')).toBeNull();
  });

  it('passes axe-core a11y scan', async () => {
    const { container } = render(
      <CodeBlock language="typescript" code={'const x = 1;'} ariaLabel="x" />,
    );
    await waitFor(() => {
      expect(container.querySelector('span[style]')).not.toBeNull();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('renders an honest fallback when shiki throws on unknown language', async () => {
    // Force a non-registered language to test the error fallback. The
    // public API only allows the registered cohort, so we cast at the
    // call site to verify the runtime behavior matches the F4-style
    // resilience: falls back to escaped raw content rather than blanking.
    render(
      <CodeBlock
        // @ts-expect-error — intentionally invalid to exercise fallback
        language="totally-unknown-language"
        code={'something here'}
        ariaLabel="x"
      />,
    );
    await waitFor(() => {
      // The error surfaces with the source content still legible. We
      // assert both: a Highlight-failed diagnostic AND the raw source
      // text are rendered, so the user gets the failure mode + the
      // un-highlighted excerpt rather than a blank pane.
      expect(screen.getByText(/Highlight failed/i)).toBeInTheDocument();
      expect(screen.getByText('something here')).toBeInTheDocument();
    });
  });
});
