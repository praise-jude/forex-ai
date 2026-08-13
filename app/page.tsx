import { redirect } from "next/navigation";

// "/" has never had a real landing page of its own (see README's "Not built yet" --
// a public marketing site is a later stage) -- send visitors straight to the actual
// app instead of leaving create-next-app's untouched starter content live in
// production, which read as a broken deploy rather than "nothing built here yet".
export default function Home() {
  redirect("/dashboard");
}
