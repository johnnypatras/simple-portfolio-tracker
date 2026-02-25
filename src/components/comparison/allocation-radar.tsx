"use client";

import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface AllocationRadarProps {
  viewerAllocation: { crypto: number; stocks: number; cash: number };
  ownerAllocation: { crypto: number; stocks: number; cash: number };
  viewerName: string;
  ownerName: string;
}

export function AllocationRadar({
  viewerAllocation,
  ownerAllocation,
  viewerName,
  ownerName,
}: AllocationRadarProps) {
  const radarData = [
    {
      axis: "Crypto",
      viewer: viewerAllocation.crypto,
      owner: ownerAllocation.crypto,
    },
    {
      axis: "Equities",
      viewer: viewerAllocation.stocks,
      owner: ownerAllocation.stocks,
    },
    {
      axis: "Cash",
      viewer: viewerAllocation.cash,
      owner: ownerAllocation.cash,
    },
  ];

  return (
    <ResponsiveContainer width="100%" height={280}>
      <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
        <PolarGrid stroke="#3f3f46" />
        <PolarAngleAxis
          dataKey="axis"
          tick={{ fill: "#a1a1aa", fontSize: 12 }}
        />
        <Radar
          name={viewerName}
          dataKey="viewer"
          stroke="#3b82f6"
          fill="#3b82f6"
          fillOpacity={0.25}
          dot={{ r: 3, fill: "#3b82f6" }}
        />
        <Radar
          name={ownerName}
          dataKey="owner"
          stroke="#f97316"
          fill="#f97316"
          fillOpacity={0.25}
          dot={{ r: 3, fill: "#f97316" }}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "#a1a1aa" }}
          iconType="circle"
          iconSize={8}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}
