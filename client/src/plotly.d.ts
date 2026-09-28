// Minimal ambient types for the partial Plotly bundle (bar/scatter/pie only). We use the
// imperative API (Plotly.react/purge) rather than react-plotly.js, which has no React 19 peer.
// Only the surface we actually touch is typed; the index signature covers the rest.
declare module 'plotly.js-basic-dist-min' {
  export interface PlotData {
    type?: string
    x?: (string | number)[]
    y?: (number | null)[]
    name?: string
    orientation?: 'v' | 'h'
    marker?: { color?: string | string[]; line?: { color?: string; width?: number } }
    text?: string[]
    texttemplate?: string | string[]
    textposition?: string
    textfont?: { color?: string; size?: number; family?: string }
    cliponaxis?: boolean
    hovertemplate?: string | string[]
    [key: string]: unknown
  }
  export interface PlotLayout {
    [key: string]: unknown
  }
  export interface PlotConfig {
    responsive?: boolean
    displayModeBar?: boolean
    [key: string]: unknown
  }
  interface PlotlyStatic {
    react(
      root: HTMLElement,
      data: PlotData[],
      layout?: Partial<PlotLayout>,
      config?: Partial<PlotConfig>,
    ): Promise<void>
    purge(root: HTMLElement): void
  }
  const Plotly: PlotlyStatic
  export default Plotly
}
