import StatusPage from "@/components/StatusPage";

export default function Unauthorized() {
  return (
    <StatusPage
      statusCode={401}
      title="Authentication Required"
      description="Please authenticate with a valid session before continuing."
      actionLabel="Open Main Site"
      redirectUrl="https://voltexchat.online"
      redirectInSeconds={6}
      enableRedirect
    />
  );
}
