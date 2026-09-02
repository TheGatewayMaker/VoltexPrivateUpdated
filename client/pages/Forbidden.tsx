import StatusPage from "@/components/StatusPage";

export default function Forbidden() {
  return (
    <StatusPage
      statusCode={403}
      title="Access Forbidden"
      description="This section is protected. Your current account does not have permission to access it."
      actionLabel="Back To Sign In"
      actionHref="/signin"
      enableRedirect={false}
    />
  );
}
