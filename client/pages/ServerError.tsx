import StatusPage from "@/components/StatusPage";

export default function ServerError() {
  return (
    <StatusPage
      statusCode={500}
      title="Server Error"
      description="Voltex encountered an unexpected condition while processing this request."
      actionLabel="Open Main Site"
      redirectUrl="https://voltexchat.online"
      redirectInSeconds={6}
      enableRedirect
    />
  );
}
