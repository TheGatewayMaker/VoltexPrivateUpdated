import { DemoResponse } from "@shared/api";
import { useEffect, useState } from "react";
import { Loader } from "@/components/ui/loader";

export default function Index() {
  const [exampleFromServer, setExampleFromServer] = useState("");
  // Fetch users on component mount
  useEffect(() => {
    fetchDemo();
  }, []);

  // Example of how to fetch data from the server (if needed)
  const fetchDemo = async () => {
    try {
      const response = await fetch("/api/demo");
      const data = (await response.json()) as DemoResponse;
      setExampleFromServer(data.message);
    } catch (error) {
      console.error("Error fetching hello:", error);
    }
  };

  return (
    <div className="app-screen-min flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
      <div className="text-center">
        {/* TODO: FUSION_GENERATION_APP_PLACEHOLDER replace everything here with the actual app! */}
        <h1 className="text-2xl font-semibold text-slate-800 flex items-center justify-center gap-3">
          <Loader />
          Generating your app...
        </h1>
        <p className="mt-4 text-slate-600 max-w-md">
          Watch the chat on the left for updates that might need your attention
          to finish generating
        </p>
        <p className="mt-4 hidden max-w-md">{exampleFromServer}</p>
      </div>
    </div>
  );
}
