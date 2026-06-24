import Link from "next/link";

export default function PaymentCancelPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full text-center">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </div>
        <h2 className="text-2xl font-bold mb-4 text-gray-800">Payment Cancelled</h2>
        <p className="text-gray-600 mb-8">
          Your payment was cancelled and you haven&apos;t been charged.
        </p>
        <Link href="/pricing" className="inline-block bg-blue-600 text-white px-6 py-2 rounded font-semibold hover:bg-blue-700 transition-colors">
          Return to Pricing
        </Link>
      </div>
    </div>
  );
}
