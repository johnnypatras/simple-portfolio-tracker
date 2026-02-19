import { AlertTriangle, ExternalLink } from "lucide-react";

export default function SetupPage() {
  const vars = [
    {
      name: "NEXT_PUBLIC_SUPABASE_URL",
      where: "Project Settings → API → Project URL",
    },
    {
      name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      where: "Project Settings → API → anon / public key",
    },
    {
      name: "SUPABASE_SERVICE_ROLE_KEY",
      where: "Project Settings → API → service_role / secret key",
    },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-4">
            <AlertTriangle className="w-6 h-6 text-amber-400" />
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">
            Configuration Required
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Supabase environment variables are missing
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-4">
          {/* Step 1 */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-medium text-zinc-200 mb-2">
              1. Create a Supabase project
            </h2>
            <p className="text-sm text-zinc-400">
              Go to{" "}
              <a
                href="https://supabase.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
              >
                supabase.com
                <ExternalLink className="w-3 h-3" />
              </a>{" "}
              and create a free project. Run the migrations from the{" "}
              <code className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded">
                supabase/migrations/
              </code>{" "}
              folder in the SQL editor.
            </p>
          </div>

          {/* Step 2 */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-medium text-zinc-200 mb-2">
              2. Copy the environment template
            </h2>
            <pre className="text-sm bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-green-400 overflow-x-auto">
              cp .env.example .env.local
            </pre>
          </div>

          {/* Step 3 */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-medium text-zinc-200 mb-3">
              3. Fill in your keys
            </h2>
            <div className="space-y-2">
              {vars.map((v) => (
                <div key={v.name} className="flex flex-col gap-0.5">
                  <code className="text-xs text-amber-400 font-mono">
                    {v.name}
                  </code>
                  <span className="text-xs text-zinc-500">{v.where}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Step 4 */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-medium text-zinc-200 mb-2">
              4. Restart the dev server
            </h2>
            <pre className="text-sm bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-green-400 overflow-x-auto">
              npm run dev
            </pre>
          </div>
        </div>

        <p className="text-xs text-zinc-600 text-center mt-6">
          See the{" "}
          <a
            href="https://github.com/johnnypatras/simple-portfolio-tracker#getting-started"
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-500 hover:text-zinc-300"
          >
            README
          </a>{" "}
          for the full setup guide.
        </p>
      </div>
    </div>
  );
}
