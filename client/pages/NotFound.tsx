import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import StatusPage from "@/components/StatusPage";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname,
    );
  }, [location.pathname]);

  return (
    <StatusPage
      statusCode={404}
      title="Page Not Found"
      description="The address you opened does not exist in Voltex right now."
      actionLabel="Open Main Site"
      redirectUrl="https://voltexchat.online"
      redirectInSeconds={6}
      enableRedirect
    />
  );
};

export default NotFound;
