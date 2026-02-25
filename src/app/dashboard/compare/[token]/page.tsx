import { getComparisonData } from "@/lib/actions/comparison";
import { redirect, notFound } from "next/navigation";
import { ComparisonPage } from "@/components/comparison/comparison-page";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function ComparePage({ params }: Props) {
  const { token } = await params;
  const result = await getComparisonData(token);

  if (!result.ok) {
    if (result.error === "not_authenticated") redirect("/login");
    notFound();
  }

  return <ComparisonPage data={result.data} token={token} />;
}
