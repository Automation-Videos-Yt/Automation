import Link from "next/link";

export default function PaymentSuccessPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
          </svg>
        </div>
        <h2 className="text-2xl font-bold mb-4 text-gray-800">Payment Successful!</h2>
        <p className="text-gray-600 mb-8">
          Thank you for subscribing. Your account has been upgraded successfully.
        </p>
        <Link href="/" className="inline-block bg-blue-600 text-white px-6 py-2 rounded font-semibold hover:bg-blue-700 transition-colors">
          Return to Dashboard
        </Link>
      </div>
    </div>
  );
}
