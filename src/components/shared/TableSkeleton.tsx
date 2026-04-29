export default function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="bg-gray-50/50 border-b border-gray-100">
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i} className="px-4 py-3">
                <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: i === 0 ? 16 : i === 1 ? 80 : 60 }} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {Array.from({ length: rows }).map((_, ri) => (
            <tr key={ri}>
              {Array.from({ length: cols }).map((_, ci) => (
                <td key={ci} className="px-4 py-3.5">
                  <div
                    className="h-3 bg-gray-100 rounded animate-pulse"
                    style={{
                      width: ci === 0 ? 16 : ci === 1 ? `${60 + (ri % 3) * 20}%` : ci === cols - 1 ? 32 : `${40 + (ci % 2) * 20}%`,
                      opacity: 1 - ri * 0.12,
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
