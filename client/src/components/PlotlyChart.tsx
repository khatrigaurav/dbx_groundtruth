import { useEffect, useRef } from 'react'
import Plotly, { type PlotData, type PlotLayout } from 'plotly.js-basic-dist-min'

// Thin imperative wrapper around the partial Plotly bundle. react-plotly.js has no React 19
// peer, so we drive Plotly.react directly and purge on unmount. `responsive: true` lets Plotly
// track container resizes itself. Callers should memoize `data`/`layout` so we only re-plot on
// real changes.
export function PlotlyChart({ data, layout, style }: {
  data: PlotData[]
  layout: Partial<PlotLayout>
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    void Plotly.react(el, data, layout, { responsive: true, displayModeBar: false })
    return () => Plotly.purge(el)
  }, [data, layout])

  return <div ref={ref} style={style} />
}
