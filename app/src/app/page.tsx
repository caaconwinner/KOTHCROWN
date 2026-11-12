import { PreLaunch } from "@/components/PreLaunch";
import { Throne } from "@/components/Throne";
import { LIVE } from "@/lib/api";

export default function Page() {
  return LIVE ? <Throne /> : <PreLaunch />;
}
